// Converts the named trips to the Trip Page Kit's PAST MODE (and re-runs the Croatia kit with the wording fixes).
//   DRY RUN (default): reads the live database, builds each plan, writes NOTHING (the fact-sheet cache stays in memory), prints and saves
//                      docs/factory/past-trip-convert-dryrun.json.
//   --apply          : first saves docs/factory/past-trip-convert-before.json (the rows, the kit records and the stored text that
//                      implies a cancellation; no secrets), then writes each plan through applyTripKitPlan / commitEdits (logged,
//                      Undo-able from Add details, Revert on the kit source) and saves docs/factory/past-trip-convert-applied.json.
// Safeguards: only the slugs in TARGETS; never a price; never publish, unpublish or delete; no photos; a field with a value is only
// replaced when it holds a "cancelled" sentence from the supplier page (that sentence is removed, nothing else in the field changes) or,
// for the kit's own previous description, when it is identical to what the kit itself last logged (a human edit is left alone).
// Run: pnpm dlx tsx scripts/convert-past-trips.ts [--apply] [--only=slug,slug]
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

const TARGETS = ['hh-social-southern-italy-sicily', 'sandy-toes-salty-souls-girls-trip', 'croatia-coastline-yacht-cruise']
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null
const CANCEL = /\b(?:tour |trip )?cancel+ed\b/i

/** The text without the sentences that say "cancelled" (nothing else is touched). */
function withoutCancelled(text: string, split: (t: string) => string[]): string {
  return split(text).filter((s) => !CANCEL.test(s)).join(' ')
}

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { getAllPackagesAdmin, getPackageById } = await import('../lib/packages')
  const fill = await import('../lib/trip-kit-fill')
  const { buildSiteIndex } = await import('../lib/content-heal-run')
  const { getSettingStrict } = await import('../lib/app-settings')
  const { isPastTrip } = await import('../lib/past-trip')
  const { splitSentencesSafe } = await import('../lib/sentence-safe')
  const admin = getSupabaseAdmin()
  const today = new Date().toISOString().slice(0, 10)

  const all = await getAllPackagesAdmin()
  const picked = all.filter((p) => TARGETS.includes(p.slug) && (!ONLY || ONLY.includes(p.slug)))
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${picked.map((p) => `${p.slug} [${p.status}, ${isPastTrip(p, today) ? 'past' : 'upcoming'}]`).join('; ') || 'no target found'}`)
  if (!picked.length) return

  const sourcesOf = async (id: string) => {
    const r = await admin.from('package_sources').select('id, extracted_text, file_name, kind').eq('package_id', id)
    return (r.data ?? []) as { id: string; extracted_text: string | null; file_name: string | null; kind: string }[]
  }

  const beforeFile = 'docs/factory/past-trip-convert-before.json'
  if (APPLY) {
    if (fs.existsSync(beforeFile)) console.log(`kept the existing ${beforeFile}`)
    else {
      const trips = []
      for (const p of picked) {
        const { id, ...rest } = p as unknown as Record<string, unknown>
        const srcs = await sourcesOf(p.id)
        trips.push({
          id: p.id,
          slug: p.slug,
          row: rest,
          trip_kit_setting: (await getSettingStrict(admin, `trip_kit:${p.id}`)).value ?? null,
          trip_kit_prev_setting: (await getSettingStrict(admin, `trip_kit_prev:${p.id}`)).value ?? null,
          sources_with_cancel_wording: srcs.filter((s) => s.extracted_text && CANCEL.test(s.extracted_text)).map((s) => ({ id: s.id, file_name: s.file_name, kind: s.kind, sentences: splitSentencesSafe(s.extracted_text as string).filter((x) => CANCEL.test(x)) })),
        })
        void id
      }
      fs.mkdirSync('docs/factory', { recursive: true })
      fs.writeFileSync(beforeFile, JSON.stringify({ savedAt: new Date().toISOString(), note: 'Rows and trip_kit records of the three trips before the past-mode conversion. Restore a field with Revert on the "Trip page kit" source in Add details, or Undo the kit (puts trip_kit_prev back).', trips }, null, 1))
      console.log(`saved ${beforeFile}`)
    }
  }

  const site = await buildSiteIndex(admin)
  const deps = fill.liveDeps()
  const dbCache = fill.settingsCache(admin)
  const mem = new Map<string, string>()
  const cache: import('../lib/trip-kit-fill').FactCache = APPLY ? dbCache : { get: async (k) => mem.get(k) ?? (await dbCache.get(k)), set: async (k, v) => void mem.set(k, v) }
  const report: unknown[] = []

  for (const live of picked) {
    const past = isPastTrip(live, today)
    const budget = await fill.dailyBudget(admin, new Date())
    const b = { left: Math.min(6, budget.left), used: 0 }
    let working = live
    let rewriteDesc = false
    let descNote = ''
    if (live.slug === 'croatia-coastline-yacht-cruise' && !past) {
      // Only the kit's own previous output may be replaced: the live text must equal the kit's last logged value for the field.
      const { data: src } = await admin.from('package_sources').select('package_edits').eq('package_id', live.id).eq('file_name', fill.KIT_SOURCE_NAME).maybeSingle()
      const edits = ((src as { package_edits?: { field: string; after: unknown; reverted?: boolean }[] } | null)?.package_edits ?? []).filter((e) => e.field === 'full_description' && !e.reverted)
      const last = edits[edits.length - 1]
      const kitOwned = !!last && typeof last.after === 'string' && last.after.trim() === (live.full_description ?? '').trim()
      if (kitOwned) {
        working = { ...live, full_description: '' } as typeof live
        rewriteDesc = true
      } else descNote = 'full_description is not the kit’s own output: left alone'
    }
    const sources = (await sourcesOf(live.id)).filter((s) => s.kind !== 'photo' && s.file_name !== fill.KIT_SOURCE_NAME && s.extracted_text).map((s) => s.extracted_text as string)
    let plan = await fill.planTripKit(working, sources, deps, cache, { existing: site.existing, targets: site.targets }, b, { refresh: true })
    for (let t = 1; t < 3 && rewriteDesc && !('full_description' in plan.updates) && b.left > 0; t++) {
      plan = await fill.planTripKit(working, sources, deps, cache, { existing: site.existing, targets: site.targets }, b, { refresh: false })
    }
    plan.galleryPhotos = []
    plan.overwrites = rewriteDesc ? ['full_description'] : []
    // Scope guard: only fields that are empty now (and the kit's own description for Croatia).
    for (const f of Object.keys(plan.updates)) {
      const liveVal = (live as unknown as Record<string, unknown>)[f]
      const empty = liveVal == null || liveVal === '' || (Array.isArray(liveVal) && liveVal.length === 0)
      if (!(f === 'full_description' && rewriteDesc) && !empty) {
        delete plan.updates[f]
        plan.edits = plan.edits.filter((e) => e.field !== f)
      }
    }
    for (const e of plan.edits) if (e.field === 'full_description') e.before = live.full_description ?? null

    // Stored text that implies a cancellation: only that sentence goes (past trips only; the trip ran).
    const cancelCleanups: { field: string; removed: string[] }[] = []
    if (past) {
      const row = live as unknown as Record<string, unknown>
      for (const f of ['short_description', 'full_description', 'meta_description', 'price_includes', 'not_included']) {
        const v = row[f]
        if (typeof v !== 'string' || !CANCEL.test(v)) continue
        const after = v.split('\n').map((line) => (CANCEL.test(line) ? withoutCancelled(line, splitSentencesSafe) : line)).filter((l, i, arr) => l.trim() || arr.length === 1).join('\n').trim()
        if (after === v.trim() || !after) continue
        cancelCleanups.push({ field: f, removed: splitSentencesSafe(v).filter((s) => CANCEL.test(s)) })
        plan.updates[f] = after
        plan.overwrites.push(f)
        plan.edits = plan.edits.filter((e) => e.field !== f)
        plan.edits.push({ field: f, before: v, after, method: 'generate', at: new Date().toISOString() })
      }
      const hl = row.highlights
      if (Array.isArray(hl) && hl.some((h) => typeof h === 'string' && CANCEL.test(h))) {
        const after = hl.filter((h) => !(typeof h === 'string' && CANCEL.test(h)))
        cancelCleanups.push({ field: 'highlights', removed: hl.filter((h) => typeof h === 'string' && CANCEL.test(h)) })
        plan.updates.highlights = after
        plan.overwrites.push('highlights')
        plan.edits = plan.edits.filter((e) => e.field !== 'highlights')
        plan.edits.push({ field: 'highlights', before: hl, after, method: 'generate', at: new Date().toISOString() })
      }
    }

    const line = {
      slug: live.slug,
      status: live.status,
      past,
      fieldsToChange: Object.keys(plan.updates),
      cancelCleanups,
      descNote,
      held: plan.held,
      notes: plan.notes,
      toConfirmAfter: plan.kit.toConfirm,
      cancelInKit: JSON.stringify(plan.kit).match(/cancel[^"]{0,60}/gi) ?? [],
      kitStops: plan.kit.stops.map((s) => `${s.name}: ${s.things.map((t) => t.text).join(' | ')}`),
      attributions: plan.kit.attributions.map((a) => a.label),
      calls: b.used,
      applied: null as unknown,
    }
    if (APPLY) {
      const out = await fill.applyTripKitPlan(admin, plan, deps)
      line.applied = { applied: out.applied, skipped: out.skipped, kitSaved: out.kitSaved }
      await fill.recordDailyUse(admin, new Date(), budget.usedToday, b.used)
      const fresh = await getPackageById(live.id)
      console.log(`${live.slug}: now status=${fresh?.status}, price_value=${fresh?.price_value}`)
    }
    report.push(line)
    console.log(JSON.stringify(line, null, 1))
  }
  fs.writeFileSync(APPLY ? 'docs/factory/past-trip-convert-applied.json' : 'docs/factory/past-trip-convert-dryrun.json', JSON.stringify({ at: new Date().toISOString(), trips: report }, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
