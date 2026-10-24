// Backfill the Trip Page Kit over every current trip (Joel authorised this run).
//   DRY RUN (default): reads the live database, builds each plan (fact sheet, copy, scores), writes NOTHING to the database or
//                      storage, prints the per-package report and saves it to docs/factory/trip-kit-backfill-report.json.
//   --apply          : first saves docs/factory/trip-kit-backfill-before.json (the rows as they are, no secrets), then writes
//                      each plan through commitEdits (logged, Undo-able) and the kit JSON, and re-scores.
//   --only=<slug>    : one trip.   --refresh : ignore cached fact sheets.
// Run: pnpm dlx tsx scripts/backfill-trip-kit.ts [--apply] [--only=slug] [--refresh]
import fs from 'node:fs'
import path from 'node:path'

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
}
loadEnv()

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const REFRESH = args.includes('--refresh')
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7) ?? null
const CACHE_FILE = process.env.TRIP_KIT_CACHE || path.join(process.cwd(), 'tmp_q', 'trip-kit-cache.json')

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { getAllPackagesAdmin, getPackageById } = await import('../lib/packages')
  const fill = await import('../lib/trip-kit-fill')
  const { buildSiteIndex } = await import('../lib/content-heal-run')
  const { settingsCache } = fill
  const admin = getSupabaseAdmin()

  // A file cache first (so a dry run followed by --apply costs no second model call), the database cache second.
  let file: Record<string, string> = {}
  try {
    file = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    file = {}
  }
  const dbCache = settingsCache(admin)
  const cache: import('../lib/trip-kit-fill').FactCache = {
    get: async (k) => file[k] ?? (APPLY ? await dbCache.get(k) : null),
    set: async (k, v) => {
      file[k] = v
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
      fs.writeFileSync(CACHE_FILE, JSON.stringify(file))
      if (APPLY) await dbCache.set(k, v)
    },
  }

  const site = await buildSiteIndex(admin)
  const deps = fill.liveDeps()
  const all = (await getAllPackagesAdmin()).filter((p) => !ONLY || p.slug === ONLY)
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${all.length} trips`)

  if (APPLY) {
    const snapshot = []
    for (const p of all) {
      const kit = await dbCache.get(`trip_kit:${p.id}`)
      const { id, ...rest } = p as unknown as Record<string, unknown>
      snapshot.push({ id: p.id, slug: p.slug, row: rest, trip_kit_setting: kit })
    }
    fs.mkdirSync('docs/factory', { recursive: true })
    fs.writeFileSync('docs/factory/trip-kit-backfill-before.json', JSON.stringify({ savedAt: new Date().toISOString(), note: 'Rows before the Trip Page Kit backfill. Restore a field with Revert on the "Trip page kit" source in Add details, or copy it back from here.', trips: snapshot }, null, 1))
    console.log('saved docs/factory/trip-kit-backfill-before.json')
  }

  const report: unknown[] = []
  for (const p of all) {
    const sourcesRes = await admin.from('package_sources').select('extracted_text, file_name, kind').eq('package_id', p.id)
    const sources = ((sourcesRes.data ?? []) as { extracted_text: string | null; file_name: string | null; kind: string }[])
      .filter((s) => s.kind !== 'photo' && s.file_name !== fill.KIT_SOURCE_NAME && s.extracted_text)
      .map((s) => s.extracted_text as string)
    const budget = await fill.dailyBudget(admin, new Date())
    const b = { left: APPLY ? 4 : 4, used: 0 }
    const plan = await fill.planTripKit(p, sources, deps, cache, { existing: site.existing, targets: site.targets }, b, { refresh: REFRESH })
    let appliedInfo: unknown = null
    let afterReal = null
    if (APPLY) {
      const out = await fill.applyTripKitPlan(admin, plan, deps)
      appliedInfo = { applied: out.applied, skipped: out.skipped, photosAdded: out.photosAdded, kitSaved: out.kitSaved }
      const fresh = await getPackageById(p.id)
      if (fresh) afterReal = fill.scoreTrip(fresh, site.existing)
      await fill.recordDailyUse(admin, new Date(), budget.usedToday, b.used)
    }
    const line = {
      slug: p.slug,
      status: p.status,
      past: plan.past,
      completeness: `${plan.before.completeness.score} -> ${(afterReal ?? plan.after).completeness.score}`,
      seo: `${plan.before.seo.score} -> ${(afterReal ?? plan.after).seo.score}`,
      stillMissing: (afterReal ?? plan.after).completeness.reasons,
      seoReasons: (afterReal ?? plan.after).seo.reasons,
      fieldsToChange: Object.keys(plan.updates),
      photos: plan.galleryPhotos.length,
      stops: plan.kit.stops.map((s) => `${s.name}${s.things.length ? ` (${s.things.length})` : ''}`),
      otherStops: plan.kit.otherStops,
      routeKnown: plan.kit.routeKnown,
      sources: plan.sources,
      toConfirm: plan.kit.toConfirm,
      held: plan.held,
      notes: plan.notes,
      calls: b.used,
      applied: appliedInfo,
    }
    report.push(line)
    console.log(JSON.stringify(line, null, 1))
  }
  fs.mkdirSync('docs/factory', { recursive: true })
  fs.writeFileSync(APPLY ? 'docs/factory/trip-kit-backfill-applied.json' : 'docs/factory/trip-kit-backfill-report.json', JSON.stringify({ at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', trips: report }, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
