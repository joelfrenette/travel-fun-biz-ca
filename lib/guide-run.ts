import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { isAiConfigured } from '@/lib/ai-verify'
import { findDestinationPhoto } from '@/lib/pexels'
import { pingIndexNow } from '@/lib/indexnow'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { SITE_ID } from '@/lib/site'
import { generateSlug } from '@/lib/utils'
import { composeGuide, guideBlockers, groundingText, type GuideBrief, type BriefPackage } from '@/lib/guide-composer'
import { clearGuideFailure, readGuideFailures, recordGuideFailure, recentGuideFailureCount, MAX_GUIDE_ATTEMPTS, BREAKER_FAILURES, BREAKER_HOURS } from '@/lib/guide-failures'
import {
  GUIDE_KINDS,
  guideKinds,
  guidePath,
  getGuideAdmin,
  guidesCreatedSince,
  listGuideCandidates,
  listPublishedGuides,
  saveGuide,
  type Guide,
  type GuideCandidate,
  type GuideKind,
} from '@/lib/guides'

// Writing guides: the caps, the lock, the brief (real data only), the rotation and the one pipeline step.
// The AI and the quality gate are in lib/guide-composer.ts; the data in lib/guides.ts.

export const GUIDES_PER_DAY_KEY = 'guides_per_day'
export const GUIDES_PER_WEEK_KEY = 'guides_per_week'
export const DEFAULT_GUIDES_PER_DAY = 1
export const DEFAULT_GUIDES_PER_WEEK = 5
const MAX_PER_DAY = 5
const MAX_PER_WEEK = 21
const RUN_LOCK_KEY = 'guides_run_lock'
// A lock older than this is treated as a crashed run, so one stuck lock cannot stop guides forever.
const RUN_LOCK_STALE_MS = 10 * 60 * 1000

function whole(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw)
  return raw !== null && raw.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= max ? n : fallback
}

export async function getGuideCaps(admin: SupabaseClient): Promise<{ perDay: number; perWeek: number }> {
  const [day, week] = await Promise.all([getSetting(admin, GUIDES_PER_DAY_KEY), getSetting(admin, GUIDES_PER_WEEK_KEY)])
  return { perDay: whole(day, DEFAULT_GUIDES_PER_DAY, MAX_PER_DAY), perWeek: whole(week, DEFAULT_GUIDES_PER_WEEK, MAX_PER_WEEK) }
}

export async function setGuideCaps(admin: SupabaseClient, perDay: number, perWeek: number): Promise<{ error?: string }> {
  if (!Number.isInteger(perDay) || perDay < 0 || perDay > MAX_PER_DAY) return { error: `guides per day must be a whole number from 0 to ${MAX_PER_DAY}` }
  if (!Number.isInteger(perWeek) || perWeek < 0 || perWeek > MAX_PER_WEEK) return { error: `guides per week must be a whole number from 0 to ${MAX_PER_WEEK}` }
  const a = await setSetting(admin, GUIDES_PER_DAY_KEY, String(perDay))
  if (a.error) return a
  return setSetting(admin, GUIDES_PER_WEEK_KEY, String(perWeek))
}

/** Best-effort lock so the admin button and the pipeline cannot both spend AI credits on guides at once. */
async function acquireLock(admin: SupabaseClient): Promise<boolean> {
  const existing = await getSetting(admin, RUN_LOCK_KEY)
  if (existing) {
    const since = Date.parse(existing)
    if (!Number.isNaN(since) && Date.now() - since < RUN_LOCK_STALE_MS) return false
  }
  const { error } = await setSetting(admin, RUN_LOCK_KEY, new Date().toISOString())
  return !error
}

async function releaseLock(admin: SupabaseClient): Promise<void> {
  await setSetting(admin, RUN_LOCK_KEY, '')
}

export interface CapUsage {
  today: number | null
  week: number | null
}

/** Guides created since 00:00 UTC today and in the last 7 days, counted straight from the table. A null means
 * "could not read", and every caller treats that as "do not write" (fail closed). */
export async function readCapUsage(admin: SupabaseClient): Promise<CapUsage> {
  const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [today, week] = await Promise.all([guidesCreatedSince(admin, startOfDay), guidesCreatedSince(admin, weekAgo)])
  return { today, week }
}

// ---------------------------------------------------------------------------------------------------
// The brief: everything the writer may know, all of it real
// ---------------------------------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

interface PkgRow {
  id: string
  name: string
  slug: string
  destination: string
  category: string
  short_description: string | null
  available_from: string | null
}

export interface BuiltBrief {
  brief: GuideBrief
  relatedPackageIds: string[]
  /** Paths the article may link to, for the quality gate. */
  allowedPaths: Set<string>
}

export async function buildBrief(admin: SupabaseClient, cand: GuideCandidate): Promise<BuiltBrief> {
  const { data: pkgData } = await admin
    .from('travel_packages')
    .select('id, name, slug, destination, category, short_description, available_from')
    .eq('status', 'published')
  const pkgs = (pkgData ?? []) as PkgRow[]

  const wanted = norm(cand.name)
  const matched = pkgs
    .filter((p) => (cand.kind === 'destinations' ? generateSlug(p.destination) === cand.slug : wanted.length >= 3 && norm(`${p.name} ${p.destination}`).includes(wanted)))
    .slice(0, 4)

  const destinationSlugs = [...new Set(matched.map((p) => generateSlug(p.destination)).filter(Boolean))]
  const allDestinations = new Map(pkgs.map((p) => [generateSlug(p.destination), p.destination]))
  const guides = await listPublishedGuides()

  // The parent's display name: a package destination, or a published destination guide.
  let parentName: string | null = null
  if (cand.parent_slug) parentName = allDestinations.get(cand.parent_slug) ?? guides.find((g) => g.kind === 'destinations' && g.slug === cand.parent_slug)?.name ?? null

  const escaped = cand.name.replace(/[%_,()]/g, ' ').trim()
  const { data: kwData } = escaped
    ? await admin.from('keyword_research').select('keyword, volume').eq('country', SITE_ID).ilike('keyword', `%${escaped}%`).order('volume', { ascending: false, nullsFirst: false }).limit(8)
    : { data: [] }
  const keywords = ((kwData ?? []) as { keyword: string }[]).map((k) => k.keyword)

  let blurb: string | null = null
  if (cand.kind === 'destinations') {
    const { data } = await admin.from('destination_blurbs').select('blurb').eq('slug', cand.slug).maybeSingle()
    blurb = (data as { blurb: string } | null)?.blurb ?? null
  }

  // The links the article may use (and the only ones the gate accepts).
  const links: { path: string; label: string }[] = []
  const addLink = (path: string, label: string) => {
    if (!links.some((l) => l.path === path)) links.push({ path, label })
  }
  for (const p of matched) addLink(`/packages/${p.slug}`, `the "${p.name}" trip`)
  const bestTime = new Set((await getBestTimeToVisitSlugs()).map((d) => d.slug))
  const ownDestinations = cand.kind === 'destinations' ? [cand.slug] : [...(cand.parent_slug ? [cand.parent_slug] : []), ...destinationSlugs]
  for (const slug of [...new Set(ownDestinations)].slice(0, 3)) {
    if (cand.kind !== 'destinations' && (allDestinations.has(slug) || guides.some((g) => g.kind === 'destinations' && g.slug === slug))) addLink(`/destinations/${slug}`, `our ${allDestinations.get(slug) ?? slug} page`)
    if (bestTime.has(slug)) addLink(`/best-time-to-visit/${slug}`, `when to visit ${allDestinations.get(slug) ?? slug}`)
  }
  const siblings = guides.filter((g) => !(g.kind === cand.kind && g.slug === cand.slug))
  const related = [...siblings.filter((g) => g.kind === cand.kind).slice(0, 3), ...siblings.filter((g) => g.parent_slug === cand.slug).slice(0, 3), ...siblings.filter((g) => cand.parent_slug && g.slug === cand.parent_slug).slice(0, 1)]
  for (const g of related) addLink(guidePath(g.kind, g.slug), `our ${g.name} guide`)
  addLink('/packages', 'all our trips')
  addLink('/#contact', 'the contact form')

  const allowedPaths = new Set(links.map((l) => (l.path === '/#contact' ? '/' : l.path)))
  allowedPaths.add('/')

  const briefPackages: BriefPackage[] = matched.map((p) => ({
    name: p.name,
    slug: p.slug,
    destination: p.destination,
    category: p.category,
    short_description: p.short_description,
    year: p.available_from ? p.available_from.slice(0, 4) : null,
  }))

  return {
    brief: { kind: cand.kind, name: cand.name, parentName, packages: briefPackages, keywords, blurb, links },
    relatedPackageIds: matched.map((p) => p.id),
    allowedPaths,
  }
}


// ---------------------------------------------------------------------------------------------------
// Publish mode: what happens to a guide that passed the quality gate
// ---------------------------------------------------------------------------------------------------

export type GuidePublishMode = 'draft' | 'publish'
export const GUIDES_PUBLISH_MODE_KEY = 'guides_publish_mode'
/** Kinds the pipeline may ever publish by itself (in publish mode). Named properties (hotels, resorts, ships,
 * river cruises, yachts) always wait for an admin to click Publish, because a wrong claim about a real, named
 * business is the costly kind of mistake. */
export const AUTO_PUBLISH_KINDS: readonly GuideKind[] = ['destinations', 'cruise-lines']

/** `app_settings.guides_publish_mode`: 'draft' (the default, also when unset or unreadable) saves every guide as
 * a draft for review; 'publish' lets a guide that passed the gate go live. */
export async function getGuidePublishMode(admin: SupabaseClient): Promise<GuidePublishMode> {
  const { value, error } = await getSettingStrict(admin, GUIDES_PUBLISH_MODE_KEY)
  return !error && value === 'publish' ? 'publish' : 'draft'
}

export async function setGuidePublishMode(admin: SupabaseClient, mode: string): Promise<{ error?: string }> {
  if (mode !== 'draft' && mode !== 'publish') return { error: 'mode must be "draft" or "publish"' }
  return setSetting(admin, GUIDES_PUBLISH_MODE_KEY, mode)
}

/** Whether a gate-clean guide goes live, and if not, why it is held. Pure, so it can be tested. */
export function publishDecision(kind: GuideKind, mode: GuidePublishMode, source: 'pipeline' | 'admin', blockers: string[]): { publish: boolean; note: string | null } {
  if (blockers.length) return { publish: false, note: blockers.join('; ') }
  if (mode !== 'publish') return { publish: false, note: 'held for review (guides_publish_mode=draft)' }
  if (source === 'pipeline' && !AUTO_PUBLISH_KINDS.includes(kind)) return { publish: false, note: `held for review (${guideKinds[kind].label.toLowerCase()} guides name a real business, so an admin publishes them)` }
  return { publish: true, note: null }
}

// ---------------------------------------------------------------------------------------------------
// Writing one guide
// ---------------------------------------------------------------------------------------------------

export interface WriteGuideResult {
  ok: boolean
  /** True only for a real failure (the AI or the save failed). A busy lock, a duplicate or a dropped run is not a failure. */
  failed?: boolean
  note: string
  guide?: Guide
  published?: boolean
  blockers?: string[]
}

/** Writes and saves ONE guide. Whether it goes live is publishDecision(): the quality gate, the publish mode
 * and (for the pipeline) the kind. Everything else is saved as a draft with the reasons in quality_notes.
 * `beforeSave` runs right before the row is written (the pipeline re-checks its caps there, because composing
 * takes a while). A candidate that already failed MAX_GUIDE_ATTEMPTS times is refused here too, so the admin
 * button cannot keep spending on it. Takes the run lock itself. A failure is remembered for Needs attention. */
export async function writeGuide(
  admin: SupabaseClient,
  cand: GuideCandidate,
  opts: { source: 'pipeline' | 'admin'; beforeSave?: () => Promise<string | null> },
): Promise<WriteGuideResult> {
  if (!isAiConfigured()) return { ok: false, note: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }
  if (!cand.slug) return { ok: false, note: 'that name has no usable web address' }
  const failureKey = `${cand.kind}:${cand.slug}`
  const earlier = (await readGuideFailures(admin))[failureKey]
  if (earlier && earlier.n >= MAX_GUIDE_ATTEMPTS) return { ok: false, note: `"${cand.name}" failed ${earlier.n} times, so it is skipped. Click Dismiss on the Needs attention item to try it again.` }
  if (!(await acquireLock(admin))) return { ok: false, note: 'another guide is being written right now' }

  let saved!: Guide
  let publishing!: boolean
  let blockers!: string[]
  try {
    if (await getGuideAdmin(admin, cand.kind, cand.slug)) return { ok: false, note: `a ${guideKinds[cand.kind].label.toLowerCase()} guide for "${cand.name}" already exists` }

    const { brief, relatedPackageIds, allowedPaths } = await buildBrief(admin, cand)
    const composed = await composeGuide(brief)
    if ('error' in composed) {
      const n = await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason: composed.error })
      return { ok: false, failed: true, note: `could not write "${cand.name}" (${composed.error}); attempt ${n} of ${MAX_GUIDE_ATTEMPTS}` }
    }
    const guide = composed.guide

    blockers = guideBlockers(guide, { grounding: groundingText(brief), allowedPaths, names: [...(brief.parentName ? [brief.parentName] : []), ...brief.links.map((l) => l.label)] })
    const decision = publishDecision(cand.kind, await getGuidePublishMode(admin), opts.source, blockers)
    publishing = decision.publish

    const stop = opts.beforeSave ? await opts.beforeSave() : null
    if (stop) {
      // The money was spent and nothing was saved: that counts as a failure for the breaker.
      await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason: stop })
      return { ok: false, failed: true, note: `could not write "${cand.name}": ${stop}` }
    }

    const info = guideKinds[cand.kind]
    const query = cand.kind === 'destinations' ? guide.hero_query || cand.name : `${info.stockPhotoQuery}${brief.parentName ? ` ${brief.parentName}` : ''}`
    const photo = await findDestinationPhoto(query).catch(() => null)

    saved = await saveGuide(admin, {
      kind: cand.kind,
      slug: cand.slug,
      name: cand.name,
      parent_slug: cand.parent_slug,
      summary: guide.summary,
      body: guide.body,
      sections: guide.sections,
      faq: guide.faq,
      key_takeaways: guide.key_takeaways,
      hero_image_url: photo?.url ?? null,
      hero_alt: photo ? `${photo.alt?.trim() || query} (stock photo)` : null,
      meta_title: guide.meta_title,
      meta_description: guide.meta_description,
      og_title: guide.og_title,
      og_description: guide.og_description,
      primary_keyword: guide.primary_keyword,
      secondary_keywords: guide.secondary_keywords,
      related_package_ids: relatedPackageIds,
      status: publishing ? 'published' : 'draft',
      source: 'ai',
      quality_notes: decision.note,
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown error'
    await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason }).catch(() => undefined)
    return { ok: false, failed: true, note: `could not write "${cand.name}": ${reason}` }
  } finally {
    await releaseLock(admin)
  }

  // The guide is saved. Nothing below may turn that into a "could not write".
  const info = guideKinds[cand.kind]
  try {
    await clearGuideFailure(admin, failureKey)
    if (publishing) await pingIndexNow([guidePath(saved.kind, saved.slug), info.urlPrefix, '/sitemap.xml'])
  } catch {
    // housekeeping only
  }
  return {
    ok: true,
    guide: saved,
    published: publishing,
    blockers,
    note: publishing ? `wrote and published the ${info.label.toLowerCase()} guide "${cand.name}"` : `wrote "${cand.name}" as a draft (${saved.quality_notes ?? 'held for review'})`,
  }
}

// ---------------------------------------------------------------------------------------------------
// Rotation and the pipeline step
// ---------------------------------------------------------------------------------------------------

const ORIGIN_ORDER: Record<GuideCandidate['origin'], number> = { destination: 0, package: 1, seed: 2 }

/** The next candidate: the kind whose newest guide is oldest (a kind with none yet goes first, ties in the
 * order of GUIDE_KINDS), so kinds interleave; inside the kind, real destinations before the curated names.
 * Names guessed from a package title (origin 'package') are admin suggestions only and are never picked here,
 * because "Sandals Royal Resort: 7 nights" might not really be a hotel. Anything that already failed
 * MAX_GUIDE_ATTEMPTS times is skipped. */
export async function pickNextCandidate(admin: SupabaseClient, candidates: GuideCandidate[]): Promise<GuideCandidate | null> {
  const failures = await readGuideFailures(admin)
  const eligible = candidates.filter((c) => c.origin !== 'package' && (failures[`${c.kind}:${c.slug}`]?.n ?? 0) < MAX_GUIDE_ATTEMPTS)
  if (eligible.length === 0) return null

  const { data } = await admin.from('guides').select('kind, created_at').order('created_at', { ascending: false })
  const newest = new Map<string, string>()
  for (const row of (data ?? []) as { kind: string; created_at: string }[]) if (!newest.has(row.kind)) newest.set(row.kind, row.created_at)

  const kinds = GUIDE_KINDS.filter((k) => eligible.some((c) => c.kind === k))
  kinds.sort((a, b) => {
    const ta = newest.get(a) ?? ''
    const tb = newest.get(b) ?? ''
    return ta === tb ? GUIDE_KINDS.indexOf(a) - GUIDE_KINDS.indexOf(b) : ta < tb ? -1 : 1
  })
  const kind: GuideKind = kinds[0]
  return eligible.filter((c) => c.kind === kind).sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin])[0] ?? null
}

/** The pipeline's guides step: at most `guides_per_day` and `guides_per_week` (counted from the guides table,
 * failing closed), one guide per call, and none at all while the failure breaker is tripped. The caller has
 * already checked that Autopilot is on and not paused. */
export async function runGuidesStep(admin: SupabaseClient): Promise<{ ok: boolean; note: string }> {
  const { perDay, perWeek } = await getGuideCaps(admin)
  if (perDay === 0 || perWeek === 0) return { ok: true, note: 'guides are switched off (a cap is 0)' }
  if (!isAiConfigured()) return { ok: true, note: 'AI writing is not configured, so no guides' }

  // The breaker comes before any AI call. If the log cannot be read, stay closed.
  const recentFailures = await recentGuideFailureCount(admin)
  if (recentFailures === null) return { ok: false, note: 'could not check recent guide failures, so nothing was written' }
  if (recentFailures >= BREAKER_FAILURES) return { ok: false, note: `paused after ${recentFailures} failures in ${BREAKER_HOURS}h (click Dismiss on the Needs attention item to resume)` }

  const usage = await readCapUsage(admin)
  // Fail closed AND visible: if the count cannot be read (for example the guides table does not exist yet),
  // nothing is written and the step shows as failed so it appears under Needs attention.
  if (usage.today === null || usage.week === null) return { ok: false, note: 'could not check how many guides were written (is the guides table set up?), so nothing was written' }
  if (usage.today >= perDay) return { ok: true, note: `daily cap reached (${usage.today} of ${perDay} today)` }
  if (usage.week >= perWeek) return { ok: true, note: `weekly cap reached (${usage.week} of ${perWeek} this week)` }

  const cand = await pickNextCandidate(admin, await listGuideCandidates(admin))
  if (!cand) return { ok: true, note: 'no guide candidates left (all written, or skipped after repeated failures)' }

  const result = await writeGuide(admin, cand, {
    source: 'pipeline',
    // Composing takes a while: look at the caps again right before saving, so two runs cannot both write.
    beforeSave: async () => {
      const again = await readCapUsage(admin)
      if (again.today === null || again.week === null || again.today >= perDay || again.week >= perWeek) return 'a guide was written while this one was being composed, so this one was dropped'
      return null
    },
  })
  return { ok: !result.failed, note: result.note }
}
