import type { SupabaseClient } from '@supabase/supabase-js'
import { getSettingStrict } from '@/lib/app-settings'
import { claimDailyOnce } from '@/lib/content-edits'
import { isAutomationPaused } from '@/lib/automation-kill-switch'
import { buildSiteIndex } from '@/lib/content-heal-run'
import { getPackageById, getAllPackagesAdmin, type DbPackage } from '@/lib/packages'
import { isPastTrip } from '@/lib/past-trip'
import { recapStatusOf, type RecapStatus } from '@/lib/past-trip-kit'
import { parseBundle, recapBundleKey } from '@/lib/recap-studio'
import { completenessScore } from '@/lib/package-completeness'
import { tripKitKey, parseTripKit, parsePriceConfirmed, tripPriceConfirmedKey, type TripKit, type PriceConfirmed } from '@/lib/trip-kit-facts'
import {
  planTripKit,
  applyTripKitPlan,
  settingsCache,
  liveDeps,
  dailyBudget,
  recordDailyUse,
  scoreTrip,
  needsKit,
  KIT_SOURCE_NAME,
  type FillDeps,
  type Scores,
} from '@/lib/trip-kit-fill'

// The one entry point for "fill this page": the admin button, the batch and the autopilot all call runTripKitFill.
// It reads the trip, runs the plan (cached fact sheet, capped AI calls), writes through commitEdits, and re-scores.

export interface KitRunResult {
  ok: boolean
  error?: string
  packageId: string
  slug?: string
  applied: string[]
  skipped: { field: string; reason: string }[]
  photosAdded: number
  before?: Scores
  after?: Scores
  toConfirm: string[]
  held: { field: string; reasons: string[] }[]
  notes: string[]
  calls: number
}

async function storedSources(admin: SupabaseClient, packageId: string): Promise<string[]> {
  const { data } = await admin.from('package_sources').select('extracted_text, file_name, kind').eq('package_id', packageId)
  return ((data ?? []) as { extracted_text: string | null; file_name: string | null; kind: string }[])
    .filter((s) => s.kind !== 'photo' && s.file_name !== KIT_SOURCE_NAME && s.extracted_text)
    .map((s) => s.extracted_text as string)
}

export async function runTripKitFill(admin: SupabaseClient, packageId: string, opts: { deps?: FillDeps; refresh?: boolean; now?: Date } = {}): Promise<KitRunResult> {
  const now = opts.now ?? new Date()
  const empty: KitRunResult = { ok: false, packageId, applied: [], skipped: [], photosAdded: 0, toConfirm: [], held: [], notes: [], calls: 0 }
  const pkg = await getPackageById(packageId)
  if (!pkg) return { ...empty, error: 'Trip not found.' }
  const budgetInfo = await dailyBudget(admin, now)
  if (budgetInfo.left <= 0) return { ...empty, slug: pkg.slug, error: 'Today’s limit of AI calls for trip pages is used. It resets tomorrow.' }
  const site = await buildSiteIndex(admin)
  const deps = opts.deps ?? liveDeps()
  const budget = { left: budgetInfo.left, used: 0 }
  const plan = await planTripKit(pkg, await storedSources(admin, packageId), deps, settingsCache(admin), { existing: site.existing, targets: site.targets }, budget, { refresh: opts.refresh })
  const out = await applyTripKitPlan(admin, plan, deps)
  await recordDailyUse(admin, now, budgetInfo.usedToday, budget.used)
  const fresh = (await getPackageById(packageId)) ?? pkg
  return {
    ok: out.kitSaved,
    error: out.kitSaved ? undefined : 'The page record could not be saved.',
    packageId,
    slug: pkg.slug,
    applied: out.applied,
    skipped: out.skipped,
    photosAdded: out.photosAdded,
    before: plan.before,
    after: scoreTrip(fresh, site.existing),
    toConfirm: plan.kit.toConfirm,
    held: plan.held,
    notes: plan.notes,
    calls: budget.used,
  }
}

export interface KitStatus {
  completeness: Scores['completeness']
  seo: Scores['seo']
  hasKit: boolean
  generatedAt: string | null
  toConfirm: string[]
  price: PriceConfirmed | null
  past: boolean
  /** Photos, quotes and to-do of a past trip's recap (all zero and empty for a trip that has not happened). */
  recap: RecapStatus
}

/** What the admin panel shows for one trip. No AI, no writes. */
export async function tripKitStatus(admin: SupabaseClient, pkg: DbPackage): Promise<KitStatus> {
  const [kitRaw, priceRaw, bundleRaw] = await Promise.all([getSettingStrict(admin, tripKitKey(pkg.id)), getSettingStrict(admin, tripPriceConfirmedKey(pkg.id)), getSettingStrict(admin, recapBundleKey(pkg.id))])
  const quotes = parseBundle(bundleRaw.value)?.quotes.length ?? 0
  const recap = recapStatusOf({ slug: pkg.slug, available_to: pkg.available_to, recap_mode: pkg.recap_mode, gallery_urls: pkg.gallery_urls, recap_summary: pkg.recap_summary, quotes })
  const kit: TripKit | null = parseTripKit(kitRaw.value)
  const site = await buildSiteIndex(admin)
  const scores = scoreTrip(pkg, site.existing)
  return { completeness: scores.completeness, seo: scores.seo, hasKit: !!kit, generatedAt: kit?.generatedAt ?? null, toConfirm: kit?.toConfirm ?? [], price: parsePriceConfirmed(priceRaw.value), past: isPastTrip(pkg), recap }
}

/** Trips (published or draft) below the target or without a saved kit, thin ones first. For "Fill all thin pages". */
export async function thinTrips(admin: SupabaseClient, cooldownDays = 0, now: Date = new Date()): Promise<{ id: string; name: string; slug: string; score: number; thin: boolean; status: string; pastKit: boolean }[]> {
  const all = await getAllPackagesAdmin()
  const { data } = await admin.from('app_settings').select('key, value').like('key', 'trip_kit:%')
  const made = new Map<string, number>()
  const pastMade = new Set<string>()
  for (const r of (data ?? []) as { key: string; value: string }[]) {
    const kit = parseTripKit(r.value)
    made.set(r.key.replace('trip_kit:', ''), Date.parse(kit?.generatedAt ?? '') || 0)
    if (kit?.past) pastMade.add(r.key.replace('trip_kit:', ''))
  }
  const have = new Set([...made.keys()])
  const recent = (id: string) => cooldownDays > 0 && now.getTime() - (made.get(id) ?? 0) < cooldownDays * 86_400_000
  return all
    .filter((p) => needsKit(p, have.has(p.id)) && !(have.has(p.id) && recent(p.id)))
    .map((p) => {
      const c = completenessScore(p)
      return { id: p.id, name: p.name, slug: p.slug, score: c.score, thin: c.thin, status: p.status, pastKit: pastMade.has(p.id) }
    })
    .sort((a, b) => a.score - b.score)
}

/** Autopilot pass: at most ONE trip per pass, never while automation is paused, one try per trip per day, within the daily
 * AI cap. Published upcoming trips first. Returns a short note, or null when there is nothing to do. */
export async function autopilotTripKitStep(admin: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  if (await isAutomationPaused(admin)) return null
  const candidates = await thinTrips(admin, 7, now)
  const all = await getAllPackagesAdmin()
  const byId = new Map(all.map((p) => [p.id, p]))
  // A trip that already happened is filled in "past mode" ONCE (empty fields only, nothing rewritten): once its record was made in past mode it is left alone.
  const ordered = candidates
    .filter((c) => c.status === 'published' && !(c.pastKit && isPastTrip(byId.get(c.id) as DbPackage)))
    .sort((a, b) => Number(isPastTrip(byId.get(a.id) as DbPackage)) - Number(isPastTrip(byId.get(b.id) as DbPackage)) || a.score - b.score)
  for (const c of ordered) {
    if (!(await claimDailyOnce(admin, `trip-kit:${c.id}`, now))) continue
    const r = await runTripKitFill(admin, c.id, { now })
    return r.ok ? `trip page kit: ${c.slug} ${r.before?.completeness.score ?? '?'} to ${r.after?.completeness.score ?? '?'}` : `trip page kit: ${c.slug} not filled (${r.error ?? 'no change'})`
  }
  return null
}
