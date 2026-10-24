import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, getSettingStrict, setSetting } from '@/lib/app-settings'
import { isAiConfigured } from '@/lib/ai-verify'
import { findDestinationPhoto } from '@/lib/pexels'
import { pingIndexNow } from '@/lib/indexnow'
import { getBestTimeToVisitSlugs } from '@/lib/best-time-to-visit'
import { SITE_ID } from '@/lib/site'
import { generateSlug } from '@/lib/utils'
import { planCountryName } from '@/lib/guide-plan'
import { composeGuide, guideBlockers, groundingText, type GuideBrief, type BriefPackage } from '@/lib/guide-composer'
import { deleteEdits } from '@/lib/content-edits'
import { finalizeEdits, repairComposedGuide } from '@/lib/content-repair-adapters'
import { healComposedGuide, healNoteOf } from '@/lib/heal-targets'
import { SAFE_PAGE_NOTE, isSafePageNote } from '@/lib/guide-repairs'
import { freedBySince, rejectLimitReached, type HealOutcome } from '@/lib/heal-loop'
import { enrollGuideIfDue } from '@/lib/guide-distribution'
import { checkCadence, guideCadenceKey, guideLimits, recordPublish } from '@/lib/publish-cadence'
import { inferScope } from '@/lib/guide-scope'
import { MODE_HOLD_NOTE } from '@/lib/guide-list'
import { BACKFILL_KIND_ORDER, backfillProgress, effectiveGuideCaps, planBackfill, readBackfillState, type BackfillPlan, type BackfillProgress, type BackfillState } from '@/lib/guide-backfill'
import { loadQuestionHints } from '@/lib/question-hints'
import { clearGuideFailure, readGuideFailures, recordGuideFailure, recentGuideFailureCount, MAX_GUIDE_ATTEMPTS, BREAKER_FAILURES, BREAKER_HOURS } from '@/lib/guide-failures'
import {
  GUIDE_KINDS,
  guideKinds,
  guidePath,
  getGuideAdmin,
  isRetryableRejected,
  rejectionCountFor,
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
  // WP19: a guide the heal rejected (rejected_by_heal) does not use up the day's or the week's slot, so the pipeline moves on
  // to the next guide by itself. A count that could not be read stays null (nothing is written); a list that could not be
  // read frees nothing.
  const free = (since: string) => freedBySince(admin, { table: 'guides', type: 'guide', columns: 'kind, slug', keyOf: (r) => `guide:${String(r.kind)}:${String(r.slug)}` }, since)
  const [freedToday, freedWeek] = today === null || week === null ? [0, 0] : await Promise.all([free(startOfDay), free(weekAgo)])
  return { today: today === null ? null : Math.max(0, today - freedToday), week: week === null ? null : Math.max(0, week - freedWeek) }
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
  if (cand.parent_slug) parentName = allDestinations.get(cand.parent_slug) ?? guides.find((g) => g.kind === 'destinations' && g.slug === cand.parent_slug)?.name ?? planCountryName(cand.parent_slug)

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

  // Real searcher questions for the FAQ (hub WP5): stored Search Console searches and question headings in our own posts. [] when none.
  const questions = await loadQuestionHints(admin, [cand.name, ...keywords])

  const briefPackages: BriefPackage[] = matched.map((p) => ({
    name: p.name,
    slug: p.slug,
    destination: p.destination,
    category: p.category,
    short_description: p.short_description,
    year: p.available_from ? p.available_from.slice(0, 4) : null,
  }))

  return {
    brief: { kind: cand.kind, name: cand.name, parentName, packages: briefPackages, keywords, blurb, links, ...(cand.planned ? { planned: true } : {}), ...(questions.length ? { questions } : {}) },
    relatedPackageIds: matched.map((p) => p.id),
    allowedPaths,
  }
}


// ---------------------------------------------------------------------------------------------------
// Publish mode: what happens to a guide that passed the quality gate
// ---------------------------------------------------------------------------------------------------

export type GuidePublishMode = 'draft' | 'publish'
export const GUIDES_PUBLISH_MODE_KEY = 'guides_publish_mode'
/** Kinds that name a real business (hotels, resorts, ships, river cruises, yachts). Until WP10 these always waited
 * for an admin to click Publish. Joel's call (2026-10-10): they may now go live by themselves in publish mode, but
 * ONLY when the gate is clean after the self-repair (nothing on the HARD list, nothing left to reword). Their social
 * posts are still enrolled as held (lib/guide-distribution.ts HELD_GUIDE_KINDS), so nothing about a named business
 * is posted to a network without a click. Kept as data so the admin text and the offline check can name them. */
export const NAMED_PROPERTY_KINDS: readonly GuideKind[] = ['hotels', 'resorts', 'ships', 'river-cruises', 'yachts']

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

/** Whether a gate-clean guide goes live, and if not, why it is held. `blockers` are what is left AFTER the
 * self-repair. Every kind, named properties included, goes live when the mode is 'publish' and no blocker is left.
 * Pure, so it can be tested. (`kind` and `source` no longer change the answer; they stay in the signature so a
 * future per-kind rule is a one-line change.) */
export function publishDecision(kind: GuideKind, mode: GuidePublishMode, source: 'pipeline' | 'admin', blockers: string[]): { publish: boolean; note: string | null } {
  void kind
  void source
  if (blockers.length) return { publish: false, note: blockers.join('; ') }
  if (mode !== 'publish') return { publish: false, note: MODE_HOLD_NOTE }
  return { publish: true, note: null }
}

// ---------------------------------------------------------------------------------------------------
// Writing one guide
// ---------------------------------------------------------------------------------------------------

/** True for a property name that "Promote this package" took from a trip title: such a guide is always a draft. */
/** What happens to a guide after the gate, the repair and the heal loop. Pure, so the offline check can prove it.
 *  - A guessed property name (a business named from a package title) is ALWAYS a draft with the "check it is real" note,
 *    whatever the heal did to its text: the heal may improve the words, never publish it.
 *  - rejected_by_heal: a draft the review queue no longer shows, with the reasons; its slot is free (see readCapUsage).
 *  - A deferral (out of budget or time, the AI down) keeps the blockers in the note and says the heal will try again.
 *  - Anything else follows publishDecision. */
export function decideGuideSave(guessed: boolean, decided: { publish: boolean; note: string | null }, heal: HealOutcome | null): { publish: boolean; note: string | null; rejectedByHeal: boolean } {
  const base = guessed ? { publish: false, note: [decided.note, GUESSED_PROPERTY_NOTE].filter(Boolean).join('; ') } : decided
  if (heal?.status === 'rejected_by_heal') return { publish: false, note: [healNoteOf(heal), guessed ? GUESSED_PROPERTY_NOTE : ''].filter(Boolean).join('; '), rejectedByHeal: true }
  if (heal?.status === 'deferred') return { publish: false, note: [base.note, healNoteOf(heal)].filter(Boolean).join('; '), rejectedByHeal: false }
  // heal-relax: a page the heal rebuilt as a safe page (only stored facts) goes live, flagged in quality_notes so a later enrichment can
  // improve it. A flagged page is not enrolled for social posting (lib/guide-distribution.ts skips any page that has notes).
  if (heal?.status === 'healed' && heal.ladder.includes('safe-page') && base.publish) return { publish: true, note: SAFE_PAGE_NOTE, rejectedByHeal: false }
  return { publish: base.publish, note: base.note, rejectedByHeal: false }
}

export const GUESSED_PROPERTY_NOTE = 'held for review: this name was taken from a trip title, so check it is a real property before you publish'

/** Does a saved guide's note say its name was guessed from a trip title? Such a guide is never published by the heal. Pure. */
export function isGuessedPropertyNote(note: string | null | undefined): boolean {
  return !!note && /taken from a trip title/.test(note)
}

export function isGuessedProperty(cand: Pick<GuideCandidate, 'origin' | 'priority' | 'backfill'>): boolean {
  // A name taken from a trip title may not be a real hotel, resort, ship or line. That holds for a promoted package
  // (WP15) and for the one-time backfill (WP16): both are always saved as drafts for a person to check.
  return cand.origin === 'package' && (!!cand.priority || !!cand.backfill)
}

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
  opts: { source: 'pipeline' | 'admin'; beforeSave?: (ctx: { publishing: boolean }) => Promise<string | null>; deadlineMs?: number },
): Promise<WriteGuideResult> {
  if (!isAiConfigured()) return { ok: false, note: 'AI writing is not configured (ANTHROPIC_API_KEY is not set)' }
  // The routes that run this are killed at 300 seconds. The self-repair only starts a model call with enough time left.
  const deadlineMs = opts.deadlineMs ?? Date.now() + 270_000
  let repairLogIds: string[] = []
  if (!cand.slug) return { ok: false, note: 'that name has no usable web address' }
  const failureKey = `${cand.kind}:${cand.slug}`
  const earlier = (await readGuideFailures(admin))[failureKey]
  if (earlier && earlier.n >= MAX_GUIDE_ATTEMPTS) return { ok: false, note: `"${cand.name}" failed ${earlier.n} times, so it is skipped. Click Dismiss on the Needs attention item to try it again.` }
  // The breaker applies to the admin buttons too: after repeated failures, stop spending until someone looks.
  const recent = await recentGuideFailureCount(admin)
  if (recent === null) return { ok: false, note: 'could not check recent guide failures, so nothing was written' }
  if (recent >= BREAKER_FAILURES) return { ok: false, note: `paused after ${recent} failures in ${BREAKER_HOURS}h. Click Dismiss on the Needs attention item on the Autopilot page to resume.` }
  if (!(await acquireLock(admin))) return { ok: false, note: 'another guide is being written right now' }

  let saved!: Guide
  let publishing!: boolean
  let blockers!: string[]
  let rejectedByHeal = false
  let replacingRejected = false
  try {
    const existingRow = await getGuideAdmin(admin, cand.kind, cand.slug)
    if (existingRow) {
      // A draft rejected over 2 days ago may be written again (replacing it), at most twice in all; anything else stays.
      if (!isRetryableRejected(existingRow, Date.now(), rejectionCountFor(earlier?.n))) {
        return { ok: false, note: `a ${guideKinds[cand.kind].label.toLowerCase()} guide for "${cand.name}" already exists` }
      }
      replacingRejected = true
    }

    const { brief, relatedPackageIds, allowedPaths } = await buildBrief(admin, cand)
    const composed = await composeGuide(brief)
    if ('error' in composed) {
      const n = await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason: composed.error })
      return { ok: false, failed: true, note: `could not write "${cand.name}" (${composed.error}); attempt ${n} of ${MAX_GUIDE_ATTEMPTS}` }
    }
    let guide = composed.guide

    const gateCtx = { grounding: groundingText(brief), allowedPaths, names: [...(brief.parentName ? [brief.parentName] : []), ...brief.links.map((l) => l.label)] }
    blockers = guideBlockers(guide, gateCtx)
    // Self-healing (WP10): reword or remove the phrases behind a REPAIRABLE blocker, then judge again. A HARD
    // blocker is never touched. Every change is logged before it is used; nothing here can add a fact.
    if (blockers.length) {
      const fixed = await repairComposedGuide(admin, guide, gateCtx, { kind: cand.kind, slug: cand.slug, path: guidePath(cand.kind, cand.slug), links: brief.links, deadlineMs })
      guide = fixed.value
      blockers = fixed.blockers
      repairLogIds = fixed.logIds
    }
    const publishMode = await getGuidePublishMode(admin)
    // Growth loop WP19: a guide that is still blocked goes through the heal loop (suggester, independent QA judge, up to
    // three rounds, then the escalation ladder) instead of waiting for a person. Only in publish mode: in draft mode every
    // guide waits for review anyway. It improves the text of a guessed property name too, but publishing that is decided
    // below, never here.
    let heal: HealOutcome | null = null
    if (blockers.length && publishMode === 'publish') {
      const healed = await healComposedGuide(admin, guide, gateCtx, { kind: cand.kind, slug: cand.slug, path: guidePath(cand.kind, cand.slug), links: brief.links, deadlineMs })
      heal = healed.outcome
      if (healed.outcome.status === 'healed') {
        guide = healed.value
        blockers = []
        repairLogIds = [...repairLogIds, ...healed.logIds]
      }
    }
    const decided = publishDecision(cand.kind, publishMode, opts.source, blockers)
    // A property name that "Promote this package" took from a trip title (origin 'package') may not be a real hotel, resort
    // or ship, so it is ALWAYS saved as a draft for a person to check, whatever guides_publish_mode says (and whatever the
    // heal did to its text). A draft is never enrolled for social posting.
    const decision = decideGuideSave(isGuessedProperty(cand), decided, heal)
    rejectedByHeal = decision.rejectedByHeal
    publishing = decision.publish

    const stop = opts.beforeSave ? await opts.beforeSave({ publishing }) : null
    // A pass dropped because a cap was reached while composing is not a failure: it must not feed the breaker.
    if (stop) {
      await deleteEdits(admin, repairLogIds)
      return { ok: false, note: stop }
    }

    const info = guideKinds[cand.kind]
    const query = cand.kind === 'destinations' ? guide.hero_query || cand.name : `${info.stockPhotoQuery}${brief.parentName ? ` ${brief.parentName}` : ''}`
    const photo = await findDestinationPhoto(query).catch(() => null)

    saved = await saveGuide(admin, {
      kind: cand.kind,
      slug: cand.slug,
      name: cand.name,
      parent_slug: cand.parent_slug,
      scope: cand.scope ?? inferScope(cand.kind, cand.name),
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
      ...(rejectedByHeal ? { review_state: 'rejected' as const } : replacingRejected ? { review_state: null } : {}),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown error'
    // The guide was never saved, so its audit rows would point at nothing.
    await deleteEdits(admin, repairLogIds).catch(() => undefined)
    await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason }).catch(() => undefined)
    return { ok: false, failed: true, note: `could not write "${cand.name}": ${reason}` }
  } finally {
    await releaseLock(admin)
  }

  // The guide is saved. Nothing below may turn that into a "could not write".
  const info = guideKinds[cand.kind]
  try {
    // Replacing a rejected draft counts as one rejection in the failure store (so a slug is retried at most once more);
    // the count must survive the save, so it is recorded instead of cleared.
    if (replacingRejected) await recordGuideFailure(admin, failureKey, { name: cand.name, kind: cand.kind, reason: 'an earlier draft was rejected and was written again' })
    else await clearGuideFailure(admin, failureKey)
    await finalizeEdits(admin, repairLogIds, { id: saved.id, path: guidePath(saved.kind, saved.slug), published: publishing })
    // Write down the go-live time for the shared publishing limiter (lib/publish-cadence.ts).
    if (publishing) await recordPublish(admin, 'guide', guideCadenceKey(saved.kind, saved.slug))
    // A published guide is enrolled for social posting (one guide a day, mode-gated; never throws).
    if (publishing) await enrollGuideIfDue(admin, saved)
    // A safe page is kept out of search (noindex, no sitemap entry), so it is not announced to search engines either.
    if (publishing && !isSafePageNote(saved.quality_notes)) await pingIndexNow([guidePath(saved.kind, saved.slug), info.urlPrefix, '/sitemap.xml'])
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
  const eligible = candidates.filter((c) => (c.origin !== 'package' || c.priority || c.backfill) && (failures[`${c.kind}:${c.slug}`]?.n ?? 0) < MAX_GUIDE_ATTEMPTS)
  if (eligible.length === 0) return null

  // A guide that "Promote this package" put at the front of the line (WP15) is written before the normal rotation, under
  // the same quality gate and caps. A destination follows the publish mode. A property name taken from a trip title
  // (origin 'package') is always saved as a draft (see writeGuide), so a guessed name is never published or posted.
  const promoted = eligible.filter((c) => c.priority)
  if (promoted.length > 0) return promoted.sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin] || (a.kind === 'destinations' ? -1 : 0) - (b.kind === 'destinations' ? -1 : 0))[0]

  // Pages on the one-time backfill list (WP16) come next: destinations first, then cruise lines, ships, resorts, hotels,
  // river cruises, yachts. They obey the same gate and publish decision; only the number written per day differs while
  // the batch runs (see effectiveGuideCaps). With the batch used up they continue here at the normal daily cap.
  const backfilled = eligible.filter((c) => c.backfill)
  if (backfilled.length > 0) return backfilled.sort((a, b) => BACKFILL_KIND_ORDER.indexOf(a.kind) - BACKFILL_KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))[0]

  const { data } = await admin.from('guides').select('kind, created_at').order('created_at', { ascending: false })
  const newest = new Map<string, string>()
  for (const row of (data ?? []) as { kind: string; created_at: string }[]) if (!newest.has(row.kind)) newest.set(row.kind, row.created_at)

  // Destination guides (the planned countries, cities and ports) take three of every four slots; the fourth goes to the normal
  // rotation so cruise lines, ships, resorts and hotels keep moving too.
  const recentKinds = ((data ?? []) as { kind: string }[]).slice(0, 3).map((r) => r.kind)
  const lastThreeAllDestinations = recentKinds.length === 3 && recentKinds.every((k) => k === 'destinations')
  const hasDestinations = eligible.some((c) => c.kind === 'destinations')
  const hasOtherKinds = eligible.some((c) => c.kind !== 'destinations')
  if (hasDestinations && !(lastThreeAllDestinations && hasOtherKinds)) {
    return eligible.filter((c) => c.kind === 'destinations').sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin])[0] ?? null
  }

  const kinds = GUIDE_KINDS.filter((k) => eligible.some((c) => c.kind === k))
  kinds.sort((a, b) => {
    const ta = newest.get(a) ?? ''
    const tb = newest.get(b) ?? ''
    return ta === tb ? GUIDE_KINDS.indexOf(a) - GUIDE_KINDS.indexOf(b) : ta < tb ? -1 : 1
  })
  const kind: GuideKind = kinds[0]
  return eligible.filter((c) => c.kind === kind).sort((a, b) => ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin])[0] ?? null
}

/** The pages a one-time backfill would queue right now, from the published trips. Reads only: no AI call, no write. */
export async function buildBackfillPlan(admin: SupabaseClient): Promise<BackfillPlan> {
  const [candidates, failures] = await Promise.all([listGuideCandidates(admin), readGuideFailures(admin)])
  return planBackfill(candidates, failures, MAX_GUIDE_ATTEMPTS)
}

/** The backfill state and how far it has got, or null when there is none or it cannot be read (no extra allowance
 * is then given: fail closed). */
export async function loadBackfillProgress(admin: SupabaseClient): Promise<{ state: BackfillState; progress: BackfillProgress } | null> {
  const state = await readBackfillState(admin)
  if (!state || state.cancelled_at) return null
  const { data, error } = await admin.from('guides').select('kind, slug, created_at')
  if (error) return null
  return { state, progress: backfillProgress(state, (data ?? []) as { kind: string; slug: string; created_at: string }[], await readGuideFailures(admin), MAX_GUIDE_ATTEMPTS) }
}

/** The caps to use for the picked page: the backfill allowance only when the page is on the backfill list, else the base caps. Pure. */
export function capsForCandidate(
  base: { perDay: number; perWeek: number },
  cand: Pick<GuideCandidate, 'backfill'> | null,
  backfill: { state: Pick<BackfillState, 'batch_cap'>; progress: Pick<BackfillProgress, 'remainingBatch'> } | null,
): { perDay: number; perWeek: number } {
  if (!cand || cand.backfill !== true || !backfill) return base
  return effectiveGuideCaps(base, backfill.progress, backfill.state.batch_cap)
}

/** The pipeline's guides step: at most `guides_per_day` and `guides_per_week` (counted from the guides table,
 * failing closed), one guide per call, and none at all while the failure breaker is tripped. The caller has
 * already checked that Autopilot is on and not paused. */
export async function runGuidesStep(admin: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<{ ok: boolean; note: string }> {
  const base = await getGuideCaps(admin)
  if (base.perDay === 0 || base.perWeek === 0) return { ok: true, note: 'guides are switched off (a cap is 0)' }
  if (!isAiConfigured()) return { ok: true, note: 'AI writing is not configured, so no guides' }

  // The breaker comes before any AI call. If the log cannot be read, stay closed.
  const recentFailures = await recentGuideFailureCount(admin)
  if (recentFailures === null) return { ok: false, note: 'could not check recent guide failures, so nothing was written' }
  if (recentFailures >= BREAKER_FAILURES) return { ok: false, note: `paused after ${recentFailures} failures in ${BREAKER_HOURS}h (click Dismiss on the Needs attention item to resume)` }

  // WP19: after MAX_REJECTS_PER_DAY items rejected by the heal, new writing waits for tomorrow (bounded AI spend).
  if ((await getGuidePublishMode(admin)) === 'publish') {
    const limit = await rejectLimitReached(admin)
    if (limit.reached) return { ok: !limit.unreadable, note: limit.note }
  }

  const usage = await readCapUsage(admin)
  // Fail closed AND visible: if the count cannot be read (for example the guides table does not exist yet),
  // nothing is written and the step shows as failed so it appears under Needs attention.
  if (usage.today === null || usage.week === null) return { ok: false, note: 'could not check how many guides were written (is the guides table set up?), so nothing was written' }

  const cand = await pickNextCandidate(admin, await listGuideCandidates(admin))
  // The one-time backfill (WP16) lifts the caps by a bounded amount, and ONLY for a page that is on its list, until its
  // batch is written. Any other page (and every page once the batch is used up) runs under the normal caps.
  const { perDay, perWeek } = capsForCandidate(base, cand, await loadBackfillProgress(admin))
  if (usage.today >= perDay) return { ok: true, note: `daily cap reached (${usage.today} of ${perDay} today)` }
  if (usage.week >= perWeek) return { ok: true, note: `weekly cap reached (${usage.week} of ${perWeek} this week)` }
  if (!cand) return { ok: true, note: 'no guide candidates left (all written, or skipped after repeated failures)' }

  // The shared publishing limiter (lib/publish-cadence.ts): rolling 24 hours / 7 days from the real go-live times, and at least
  // 90 minutes between two automatic publishes. It is asked BEFORE the AI is, so a blocked slot spends nothing; the guide is simply
  // written on a later pass (deferred, never failed). Only in publish mode: in draft mode nothing goes live.
  const limits = guideLimits({ perDay, perWeek })
  const publishMode = await getGuidePublishMode(admin)
  if (publishMode === 'publish') {
    const slot = await checkCadence(admin, 'guide', limits)
    if (!slot.allowed) return { ok: slot.reason !== 'unreadable', note: `guide publishing deferred: ${slot.note}` }
  }

  const result = await writeGuide(admin, cand, {
    source: 'pipeline',
    deadlineMs: opts.deadlineMs,
    // Composing takes a while: look at the caps again right before saving, so two runs cannot both write.
    beforeSave: async ({ publishing }) => {
      const again = await readCapUsage(admin)
      if (again.today === null || again.week === null || again.today >= perDay || again.week >= perWeek) return 'a guide was written while this one was being composed, so this one was dropped'
      // Same for the publishing limiter: a page that would go live while another one took the slot is dropped (the page is written on a later pass).
      if (publishing) {
        const slot = await checkCadence(admin, 'guide', limits)
        if (!slot.allowed) return `a guide went live while this one was being composed, so this one waits for a later slot (${slot.note})`
      }
      return null
    },
  })
  return { ok: !result.failed, note: result.note }
}
