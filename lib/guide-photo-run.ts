// Guide photo loop (database and network part). Finds PUBLISHED guides whose hero photo is missing, tiny, a wrong subject or the same
// picture as another page (lib/guide-photo.ts decides that), picks a fresh Pexels photo for each with the ranked selector, checks the new
// address answers with an image, and saves it through the content_edits log so Undo works. No new cron: the daily heal step
// (lib/content-heal-run.ts) calls runGuidePhotoHealDaily(), and scripts/heal-guide-photos.ts calls runGuidePhotoHeal() on demand: the same code.
//
// Rules this file keeps:
//   - a guide whose hero is good is never touched (the plan only lists flagged guides, and the row is re-read right before the write);
//   - a photo is saved only after it passed the accept rules, the image quality gate and a live check (200 and an image content type, 8 s);
//   - "log, then apply": no audit row, no edit; a failed update takes the audit rows back out;
//   - the daily heal does at most 3 guides a day and tries 2 query variants per guide a day (the next day moves on to the next variants);
//   - the AI illustration is used only when the existing admin setting is ON and the key is set, and only after every query variant failed;
//     this file never turns that setting on and never calls it in a dry run.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { editsLoggable, insertEdits, deleteEdits, repairDay } from '@/lib/content-edits'
import { EST_COST_USD_PER_CALL, type ContentEdit } from '@/lib/content-repair'
import { GUIDE_KINDS, guidePath, type GuideKind } from '@/lib/guides'
import { describeProblems } from '@/lib/image-quality'
import { pingIndexNow } from '@/lib/indexnow'
import { probeCover, shouldProbe } from '@/lib/cover-backfill'
import {
  GUIDE_PHOTOS_PER_DAY,
  GUIDE_PHOTO_ATTEMPTS_KEY,
  GUIDE_PHOTO_DAY_PREFIX,
  VARIANTS_PER_DAY,
  VERIFY_TOP,
  advanceAttempt,
  chooseGuidePhoto,
  collectUsed,
  flaggedGuides,
  guideIllustrationAlt,
  guideIllustrationPrompt,
  guideKey,
  guidesLeftToday,
  orderTargets,
  parseAttempts,
  passesGate,
  photoIdOfUrl,
  type FlaggedGuide,
  type GuidePhotoGuide,
  type PhotoAttempts,
  type SearchPhotos,
  type UsedPhotos,
} from '@/lib/guide-photo'
import { coverKey } from '@/lib/image-quality'

const VERIFY_TIMEOUT_MS = 8000
const READ_LIMIT = 2000
const MIN_MS_FOR_A_GUIDE = 30_000

/** True when the address answers 200 with an image content type, within 8 seconds. HEAD first, a plain GET when HEAD is refused. Never throws. */
export async function verifyImageUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const check = async (method: 'HEAD' | 'GET'): Promise<boolean> => {
    try {
      const res = await fetchImpl(url, { method, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS), cache: 'no-store' })
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      await res.body?.cancel().catch(() => undefined)
      return res.status === 200 && type.startsWith('image/')
    } catch {
      return false
    }
  }
  return (await check('HEAD')) || (await check('GET'))
}

export type PhotoSource = 'pexels' | 'ai'
export type PhotoOutcome = 'applied' | 'dry' | 'would-illustrate' | 'none' | 'skipped' | 'failed'

export interface GuidePhotoResult {
  kind: string
  slug: string
  name: string
  problems: string
  outcome: PhotoOutcome
  source: PhotoSource | null
  /** The photo that was chosen (dry run) or saved (apply). */
  url: string | null
  alt: string | null
  /** The search that found it, and plain notes about what was tried. */
  query: string | null
  note: string
}

export interface GuidePhotoReport {
  /** Published guides flagged by the image quality gate (before any limit). */
  flagged: number
  results: GuidePhotoResult[]
  fixed: number
  paths: string[]
  problems: string[]
  /** False when nothing was attempted (nothing flagged, no key, nothing allowed today ...). */
  tried: boolean
  note: string
}

export interface AiIllustrator {
  /** The admin switch AND the key: false means never use it. */
  on: boolean
  /** Makes one illustration, uploads it, returns its public address (or null). Only called in an apply run. */
  make: (prompt: string, slug: string) => Promise<string | null>
}

export interface GuidePhotoOptions {
  /** False: read and plan only (the dry run). Nothing is written and no illustration is generated. */
  apply: boolean
  limit?: number
  /** Only this guide, as kind/slug. A guide that is not flagged is left alone and said so. */
  only?: string | null
  /** The daily heal: the per-day cap, the attempts memory and 2 variants a day. Off for the script, which tries every variant now. */
  daily?: boolean
  /** Fetch each stored hero to find broken ones (slower). */
  probe?: boolean
  deadlineMs?: number
  now?: Date
  /** Test seams. */
  search?: SearchPhotos
  fetchImpl?: typeof fetch
  ai?: AiIllustrator
  pexelsConfigured?: boolean
}

type GuideRow = { id: string; kind: string; slug: string; name: string; parent_slug: string | null; hero_image_url: string | null; hero_alt: string | null; created_at: string | null; status: string }
type PostRow = { cover_image_url: string | null; alt_text: string | null; publish_date: string | null; created_at: string | null; status: string }

const toGuide = (r: GuideRow): GuidePhotoGuide => ({ id: r.id, kind: r.kind, slug: r.slug, name: r.name, parentSlug: r.parent_slug, hero: r.hero_image_url?.trim() || null, alt: r.hero_alt, date: r.created_at })

async function defaultAi(admin: SupabaseClient): Promise<AiIllustrator> {
  const [{ isImageAiConfigured, generateAiImage }, { getAutoblogAiImageFallback, uploadCoverImage }] = await Promise.all([import('@/lib/image-ai-gen'), import('@/lib/blog-image')])
  // Read only: the existing admin switch (autoblog_ai_image_fallback) and the key. Never written here.
  const on = isImageAiConfigured() && (await getAutoblogAiImageFallback(admin).catch(() => false))
  return {
    on,
    make: async (prompt, slug) => {
      const made = await generateAiImage(prompt)
      return made ? uploadCoverImage(admin, made.buffer, `guide-${slug}`, 'image/png') : null
    },
  }
}

async function defaultSearch(): Promise<{ search: SearchPhotos; configured: boolean }> {
  const { isPexelsConfigured, searchGuidePhotoCandidates } = await import('@/lib/pexels')
  return { search: searchGuidePhotoCandidates, configured: isPexelsConfigured() }
}

const dayKey = (now: Date) => `${GUIDE_PHOTO_DAY_PREFIX}:${repairDay(now)}`

async function readUsedToday(admin: SupabaseClient, now: Date): Promise<number> {
  try {
    return Math.max(0, Number(await getSetting(admin, dayKey(now))) || 0)
  } catch {
    return GUIDE_PHOTOS_PER_DAY // unreadable: fail closed, change nothing today
  }
}

async function readAttempts(admin: SupabaseClient): Promise<PhotoAttempts> {
  try {
    return parseAttempts(await getSetting(admin, GUIDE_PHOTO_ATTEMPTS_KEY))
  } catch {
    return {}
  }
}

async function writeAttempts(admin: SupabaseClient, attempts: PhotoAttempts): Promise<void> {
  try {
    await setSetting(admin, GUIDE_PHOTO_ATTEMPTS_KEY, JSON.stringify(attempts))
  } catch {
    // the memory is a nicety: losing it only means a variant is tried again
  }
}

/** The one pass. Reads the guides and posts, plans, and (when apply) writes. Never throws. */
export async function runGuidePhotoHeal(admin: SupabaseClient, opts: GuidePhotoOptions): Promise<GuidePhotoReport> {
  const now = opts.now ?? new Date()
  const report: GuidePhotoReport = { flagged: 0, results: [], fixed: 0, paths: [], problems: [], tried: false, note: '' }
  try {
    if (opts.apply && !(await editsLoggable(admin))) {
      report.problems.push('guide photos need one database update: apply migration 0033 and 0052 (supabase/migrations)')
      return report
    }
    const guidesRes = await admin.from('guides').select('id, kind, slug, name, parent_slug, hero_image_url, hero_alt, created_at, status').limit(READ_LIMIT)
    if (guidesRes.error) return { ...report, problems: [`could not read the guides: ${guidesRes.error.message}`] }
    const postsRes = await admin.from('posts').select('cover_image_url, alt_text, publish_date, created_at, status').limit(READ_LIMIT)
    if (postsRes.error) return { ...report, problems: [`could not read the posts: ${postsRes.error.message}`] }
    const guideRows = (guidesRes.data ?? []) as GuideRow[]
    const postRows = (postsRes.data ?? []) as PostRow[]

    const allGuides = new Map(guideRows.map((r) => [r.slug, { name: r.name, kind: r.kind, parentSlug: r.parent_slug }]))
    const published = guideRows.filter((r) => r.status === 'published' && GUIDE_KINDS.includes(r.kind as GuideKind)).map(toGuide)
    const postCovers = postRows.filter((p) => p.status === 'published').map((p) => ({ url: p.cover_image_url?.trim() || null, alt: p.alt_text, date: p.publish_date ?? p.created_at }))
    // Everything stored as a hero or cover, of any status, is "used": a new photo must be different from all of it.
    const used: UsedPhotos = collectUsed([...guideRows.map((r) => r.hero_image_url), ...postRows.map((p) => p.cover_image_url)])

    let broken = new Set<string>()
    if (opts.probe) {
      const urls = Array.from(new Set(published.map((g) => g.hero).filter(shouldProbe)))
      const bad = new Set<string>()
      for (let i = 0; i < urls.length; i += 6) {
        const part = urls.slice(i, i + 6)
        const probes = await Promise.all(part.map((u) => probeCover(u, opts.fetchImpl)))
        probes.forEach((p, j) => !p.ok && bad.add(part[j]))
      }
      broken = bad
    }

    const flagged = flaggedGuides(published, postCovers, broken)
    report.flagged = flagged.length
    const attempts = opts.daily || opts.apply ? await readAttempts(admin) : {}

    let targets: FlaggedGuide[] = orderTargets(flagged, attempts)
    if (opts.only) {
      const only = opts.only.trim().toLowerCase()
      targets = targets.filter((t) => guideKey(t.guide).toLowerCase() === only)
      if (targets.length === 0) {
        const exists = published.find((g) => guideKey(g).toLowerCase() === only)
        report.note = exists ? `${opts.only}: its photo is fine (not a duplicate, not missing, not tiny), so it was left alone` : `${opts.only}: no published guide with that kind/slug`
        return report
      }
    }
    if (targets.length === 0) {
      report.note = 'every guide has its own good photo'
      return report
    }
    if (opts.daily) {
      const left = guidesLeftToday(await readUsedToday(admin, now))
      if (left === 0) {
        report.note = `guide photos: today's limit of ${GUIDE_PHOTOS_PER_DAY} guides is used`
        return report
      }
      targets = targets.slice(0, left)
    }
    if (opts.limit && opts.limit > 0) targets = targets.slice(0, opts.limit)

    const real = opts.search ? { search: opts.search, configured: opts.pexelsConfigured ?? true } : await defaultSearch()
    const ai = opts.ai ?? (await defaultAi(admin))
    if (!real.configured && !ai.on) {
      report.note = 'guide photos: PEXELS_API_KEY is not set, so no photo can be chosen'
      return report
    }

    report.tried = true
    let worked = 0
    for (const t of targets) {
      if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() < MIN_MS_FOR_A_GUIDE) {
        report.problems.push('guide photos: stopped early, not enough time left today')
        break
      }
      worked++
      const result = await workOne(admin, t, { opts, allGuides, used, attempts, search: real.search, searchOn: real.configured, ai, now })
      report.results.push(result)
      if (result.outcome === 'applied') {
        report.fixed++
        report.paths.push(guidePath(t.guide.kind as GuideKind, t.guide.slug))
      }
      if (result.outcome === 'failed') report.problems.push(`${guideKey(t.guide)}: ${result.note}`)
    }

    if (opts.apply) {
      await writeAttempts(admin, attempts)
      if (opts.daily) await setSetting(admin, dayKey(now), String((await readUsedToday(admin, now)) + worked)).catch(() => undefined)
      if (report.paths.length) await pingIndexNow(report.paths).catch(() => undefined)
    }
    report.note = `guide photos: ${report.fixed} of ${report.results.length} guide${report.results.length === 1 ? '' : 's'} got a new photo, ${report.flagged} flagged in all${report.results.some((r) => r.outcome === 'none') ? '; the rest will try the next search words tomorrow' : ''}`
    return report
  } catch (e) {
    report.problems.push(`guide photos: ${e instanceof Error ? e.message : 'failed'}`)
    return report
  }
}

interface WorkCtx {
  opts: GuidePhotoOptions
  allGuides: Map<string, { name: string; kind: string; parentSlug: string | null }>
  used: UsedPhotos
  attempts: PhotoAttempts
  search: SearchPhotos
  searchOn: boolean
  ai: AiIllustrator
  now: Date
}

async function workOne(admin: SupabaseClient, t: FlaggedGuide, ctx: WorkCtx): Promise<GuidePhotoResult> {
  const g = t.guide
  const key = guideKey(g)
  const base = { kind: g.kind, slug: g.slug, name: g.name, problems: describeProblems(t.problems) }
  const daily = !!ctx.opts.daily
  const fetchImpl = ctx.opts.fetchImpl ?? fetch
  try {
    const choice = ctx.searchOn
      ? await chooseGuidePhoto(g, ctx.allGuides, ctx.used, ctx.search, { startIndex: daily ? ctx.attempts[key]?.n ?? 0 : 0, maxVariants: daily ? VARIANTS_PER_DAY : undefined })
      : null
    if (ctx.searchOn && !choice) return { ...base, outcome: 'skipped', source: null, url: null, alt: null, query: null, note: 'this kind of guide has no photo rules' }

    // The best acceptable photo whose address really answers with an image.
    let chosen: { url: string; alt: string; query: string; source: PhotoSource } | null = null
    if (choice) {
      for (const p of choice.picks.slice(0, VERIFY_TOP)) {
        if (!passesGate(p.candidate.url, choice.alt, ctx.used)) continue
        if (await verifyImageUrl(p.candidate.url, fetchImpl)) {
          chosen = { url: p.candidate.url, alt: choice.alt, query: p.query, source: 'pexels' }
          break
        }
      }
    }

    const triedNote = choice ? `tried ${choice.tried.map((x) => `"${x.query}" (${x.found} found)`).join(', ')}` : 'no photo search available'
    if (!chosen && ctx.ai.on && (!choice || choice.exhausted)) {
      // Every search variant was tried and nothing was acceptable: the admin turned the illustration fallback on, so it may be used.
      const kind = g.kind
      const place = choice?.place ?? ''
      if (!ctx.opts.apply) return { ...base, outcome: 'would-illustrate', source: 'ai', url: null, alt: guideIllustrationAlt(kind, place), query: null, note: `${triedNote}; an AI illustration would be generated (the admin switch is on)` }
      const url = await ctx.ai.make(guideIllustrationPrompt(kind, place), g.slug)
      if (url && (await verifyImageUrl(url, fetchImpl))) chosen = { url, alt: guideIllustrationAlt(kind, place), query: 'ai illustration', source: 'ai' }
    }

    if (!chosen) {
      if (ctx.opts.apply) ctx.attempts[key] = advanceAttempt(ctx.attempts[key], choice?.tried.length ?? 1, choice?.variants.length ?? 0, triedNote, ctx.now)
      return { ...base, outcome: 'none', source: null, url: null, alt: null, query: null, note: `${triedNote}; nothing acceptable, left flagged for the next try` }
    }

    // Reserve the photo in memory so the next guide in this run cannot get the same one.
    ctx.used.keys.add(coverKey(chosen.url))
    const id = photoIdOfUrl(chosen.url)
    if (id !== null) ctx.used.ids.add(id)

    if (!ctx.opts.apply) return { ...base, outcome: 'dry', source: chosen.source, url: chosen.url, alt: chosen.alt, query: chosen.query, note: 'would be saved (dry run)' }

    const applied = await applyHero(admin, g, t, chosen)
    if (applied.error) return { ...base, outcome: applied.skipped ? 'skipped' : 'failed', source: chosen.source, url: chosen.url, alt: chosen.alt, query: chosen.query, note: applied.error }
    delete ctx.attempts[key]
    return { ...base, outcome: 'applied', source: chosen.source, url: chosen.url, alt: chosen.alt, query: chosen.query, note: 'saved; Undo is on the Content edits page' }
  } catch (e) {
    return { ...base, outcome: 'failed', source: null, url: null, alt: null, query: null, note: e instanceof Error ? e.message : 'failed' }
  }
}

/** Logs, then applies, one new hero. The row is re-read first: a guide that was unpublished, or whose hero changed since the plan (a person
 * fixed it), is left alone. */
async function applyHero(admin: SupabaseClient, g: GuidePhotoGuide, flagged: FlaggedGuide, chosen: { url: string; alt: string; source: PhotoSource }): Promise<{ error?: string; skipped?: boolean }> {
  const { data: fresh, error: readError } = await admin.from('guides').select('hero_image_url, hero_alt, status').eq('id', g.id).maybeSingle()
  if (readError) return { error: `could not re-read the guide: ${readError.message}` }
  const row = fresh as { hero_image_url: string | null; hero_alt: string | null; status: string } | null
  if (!row || row.status !== 'published') return { error: 'the guide is no longer published, left alone', skipped: true }
  if ((row.hero_image_url?.trim() || null) !== g.hero) return { error: 'its photo changed since the check, left alone', skipped: true }

  const path = guidePath(g.kind as GuideKind, g.slug)
  const reason = `${describeProblems(flagged.problems)}: ${chosen.source === 'ai' ? 'a generated illustration was set' : 'a new stock photo was set'}`
  const cost = chosen.source === 'ai' ? EST_COST_USD_PER_CALL : 0
  const method: ContentEdit['method'] = chosen.source === 'ai' ? 'generate' : 'fixer'
  const edits: ContentEdit[] = [{ content_type: 'guide', content_id: g.id, path, field: 'hero_image_url', reason, before: row.hero_image_url ?? '', after: chosen.url, method, published_after: true, cost_usd: cost }]
  if ((row.hero_alt ?? '') !== chosen.alt) edits.push({ content_type: 'guide', content_id: g.id, path, field: 'hero_alt', reason, before: row.hero_alt ?? '', after: chosen.alt, method, published_after: true, cost_usd: 0 })

  const logged = await insertEdits(admin, edits)
  if (logged.error) return { error: `the audit log could not be written (${logged.error})${/check constraint/i.test(logged.error) ? '; apply migration 0052' : ''}` }
  const { error } = await admin.from('guides').update({ hero_image_url: chosen.url, hero_alt: chosen.alt, updated_at: new Date().toISOString() }).eq('status', 'published').eq('id', g.id)
  if (error) {
    await deleteEdits(admin, logged.ids)
    return { error: `could not update the guide: ${error.message}` }
  }
  return {}
}

/** The daily heal's call: at most 3 guides, 2 search variants each, never throws. */
export async function runGuidePhotoHealDaily(admin: SupabaseClient, opts: { deadlineMs?: number } = {}): Promise<{ tried: boolean; fixed: number; paths: string[]; problems: string[]; note: string }> {
  try {
    const r = await runGuidePhotoHeal(admin, { apply: true, daily: true, deadlineMs: opts.deadlineMs })
    return { tried: r.tried, fixed: r.fixed, paths: r.paths, problems: r.problems, note: r.note }
  } catch (e) {
    return { tried: false, fixed: 0, paths: [], problems: [`guide photos: ${e instanceof Error ? e.message : 'failed'}`], note: '' }
  }
}

/** For the Automation card: how many published guides have a duplicate, missing, tiny or wrong-subject photo. Null when it cannot be read.
 * Reads only, never calls the network. */
export async function countGuidesNeedingPhoto(admin: SupabaseClient): Promise<number | null> {
  try {
    const guides = await admin.from('guides').select('id, kind, slug, name, parent_slug, hero_image_url, hero_alt, created_at, status').eq('status', 'published').limit(READ_LIMIT)
    if (guides.error) return null
    const posts = await admin.from('posts').select('cover_image_url, alt_text, publish_date, created_at').eq('status', 'published').limit(READ_LIMIT)
    if (posts.error) return null
    const g = ((guides.data ?? []) as GuideRow[]).filter((r) => GUIDE_KINDS.includes(r.kind as GuideKind)).map(toGuide)
    const p = ((posts.data ?? []) as PostRow[]).map((x) => ({ url: x.cover_image_url?.trim() || null, alt: x.alt_text, date: x.publish_date ?? x.created_at }))
    return flaggedGuides(g, p).length
  } catch {
    return null
  }
}
