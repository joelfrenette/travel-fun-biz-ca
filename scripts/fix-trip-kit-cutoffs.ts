// Re-runs the Trip Page Kit ONLY for trips whose stored text holds a cut-off sentence, with the abbreviation-aware code.
//   DRY RUN (default): plans, writes nothing to the database.
//   --apply          : saves docs/factory/trip-kit-cutoff-fix-before.json (rows + kit JSON as they are now, no secrets), then writes
//                      through applyTripKitPlan / commitEdits (logged, Undo-able from Add details, Revert on the kit source).
// Safeguards: never a price, never publish or unpublish, no photos; a past trip is only filled where a field is empty; the live
// full_description is replaced only when it is identical to what the kit itself last logged for that field (a human edit is left alone).
// Run: pnpm dlx tsx scripts/fix-trip-kit-cutoffs.ts [--apply] [--only=slug,slug]
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
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null

function strings(v: unknown, where: string, out: { where: string; text: string }[]) {
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.length >= 20 && /\s/.test(t) && !/^https?:/i.test(t)) out.push({ where, text: t })
  } else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${where}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as object)) strings(x, `${where}.${k}`, out)
}

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { getAllPackagesAdmin, getPackageById } = await import('../lib/packages')
  const fill = await import('../lib/trip-kit-fill')
  const { buildSiteIndex } = await import('../lib/content-heal-run')
  const { firstCutOff } = await import('../lib/sentence-safe')
  const { getSettingStrict } = await import('../lib/app-settings')
  const admin = getSupabaseAdmin()

  const all = await getAllPackagesAdmin()
  const affected: { pkg: (typeof all)[number]; fields: string[]; kitText: boolean }[] = []
  for (const p of all) {
    if (ONLY && !ONLY.includes(p.slug)) continue
    const row = p as unknown as Record<string, unknown>
    const hits: { where: string; text: string }[] = []
    for (const [k, v] of Object.entries(row)) if (!['id', 'slug', 'booking_url', 'more_info_url', 'cover_image_url'].includes(k)) strings(v, k, hits)
    const bad = hits.filter((h) => firstCutOff(h.text)).map((h) => h.where.replace(/\[\d+\]/g, ''))
    const kitRaw = (await getSettingStrict(admin, `trip_kit:${p.id}`)).value
    const kitHits: { where: string; text: string }[] = []
    if (kitRaw) {
      try {
        strings(JSON.parse(kitRaw), 'trip_kit', kitHits)
      } catch {
        /* ignore */
      }
    }
    const kitBad = kitHits.filter((h) => firstCutOff(h.text))
    if (bad.length || kitBad.length) affected.push({ pkg: p, fields: [...new Set(bad)], kitText: kitBad.length > 0 })
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${affected.length} affected trip(s): ${affected.map((a) => `${a.pkg.slug} [${a.pkg.status}] fields=${a.fields.join(',') || '-'} kit=${a.kitText}`).join('; ')}`)
  if (!affected.length) return

  const beforeFile = 'docs/factory/trip-kit-cutoff-fix-before.json'
  if (APPLY) {
    if (fs.existsSync(beforeFile)) console.log(`kept the existing ${beforeFile}`)
    else {
      const trips = []
      for (const a of affected) {
        const { id, ...rest } = a.pkg as unknown as Record<string, unknown>
        trips.push({ id: a.pkg.id, slug: a.pkg.slug, row: rest, trip_kit_setting: (await getSettingStrict(admin, `trip_kit:${a.pkg.id}`)).value ?? null })
        void id
      }
      fs.mkdirSync('docs/factory', { recursive: true })
      fs.writeFileSync(beforeFile, JSON.stringify({ savedAt: new Date().toISOString(), note: 'Rows and trip_kit JSON of the trips with a cut-off sentence, before the cut-off fix re-run. Restore a field with Revert on the "Trip page kit" source in Add details, or Undo the kit.', trips }, null, 1))
      console.log(`saved ${beforeFile}`)
    }
  }

  const site = await buildSiteIndex(admin)
  const deps = fill.liveDeps()
  // A dry run reads the database cache but keeps every write in memory, so it changes nothing in the database.
  const dbCache = fill.settingsCache(admin)
  const mem = new Map<string, string>()
  const cache: import('../lib/trip-kit-fill').FactCache = APPLY
    ? dbCache
    : { get: async (k) => mem.get(k) ?? (await dbCache.get(k)), set: async (k, v) => void mem.set(k, v) }
  const report: unknown[] = []
  for (const a of affected) {
    const live = a.pkg
    const budget = await fill.dailyBudget(admin, new Date())
    const b = { left: Math.min(6, budget.left), used: 0 }
    let working = live
    let rewriteDesc = false
    let descNote = ''
    if (a.fields.includes('full_description')) {
      // Only the kit's own previous output may be replaced: the live text must equal the kit's last logged value for the field.
      const { data: src } = await admin.from('package_sources').select('package_edits').eq('package_id', live.id).eq('file_name', fill.KIT_SOURCE_NAME).maybeSingle()
      const edits = ((src as { package_edits?: { field: string; after: unknown; reverted?: boolean }[] } | null)?.package_edits ?? []).filter((e) => e.field === 'full_description' && !e.reverted)
      const last = edits[edits.length - 1]
      const kitOwned = !!last && typeof last.after === 'string' && last.after.trim() === (live.full_description ?? '').trim()
      const past = (await import('../lib/past-trip')).isPastTrip(live, new Date().toISOString().slice(0, 10))
      if (kitOwned && !past) {
        working = { ...live, full_description: '' } as typeof live
        rewriteDesc = true
      } else descNote = kitOwned ? 'full_description has a cut-off but the trip is in the past: left alone' : 'full_description has a cut-off but is not the kit’s own output: left alone'
    }
    const sourcesRes = await admin.from('package_sources').select('extracted_text, file_name, kind').eq('package_id', live.id)
    const sources = ((sourcesRes.data ?? []) as { extracted_text: string | null; file_name: string | null; kind: string }[])
      .filter((s) => s.kind !== 'photo' && s.file_name !== fill.KIT_SOURCE_NAME && s.extracted_text)
      .map((s) => s.extracted_text as string)
    // The writer sometimes lands under 400 words; the gate then holds the description. Retry with fresh model answers (the
    // cached answer for an identical prompt would just repeat the short one), up to 3 times.
    const stripAnswers = (c: typeof cache): typeof cache => ({
      get: async (k) => {
        const v = await c.get(k)
        if (!v || !k.startsWith('trip_kit_facts:')) return v
        try {
          const o = JSON.parse(v) as { answers?: unknown }
          delete o.answers
          return JSON.stringify(o)
        } catch {
          return v
        }
      },
      set: (k, v) => c.set(k, v),
    })
    let plan = await fill.planTripKit(working, sources, deps, cache, { existing: site.existing, targets: site.targets }, b, { refresh: true })
    for (let t = 1; t < 3 && rewriteDesc && !('full_description' in plan.updates) && b.left > 0; t++) {
      plan = await fill.planTripKit(working, sources, deps, stripAnswers(cache), { existing: site.existing, targets: site.targets }, b, { refresh: false })
    }
    // Scope guard: nothing but the description (when verified kit output) and still-empty fields; no photos.
    plan.galleryPhotos = []
    plan.overwrites = rewriteDesc ? ['full_description'] : []
    for (const f of Object.keys(plan.updates)) {
      const liveVal = (live as unknown as Record<string, unknown>)[f]
      const empty = liveVal == null || liveVal === '' || (Array.isArray(liveVal) && liveVal.length === 0)
      if (!(f === 'full_description' && rewriteDesc) && !empty) {
        delete plan.updates[f]
        plan.edits = plan.edits.filter((e) => e.field !== f)
      }
    }
    for (const e of plan.edits) if (e.field === 'full_description') e.before = live.full_description ?? null
    const line = {
      slug: live.slug,
      status: live.status,
      fieldsToChange: Object.keys(plan.updates),
      descriptionRewritten: rewriteDesc && 'full_description' in plan.updates,
      descNote,
      held: plan.held,
      notes: plan.notes,
      kitStops: plan.kit.stops.map((s) => `${s.name}: ${s.things.map((t) => t.text).join(' | ')}`),
      calls: b.used,
      applied: null as unknown,
    }
    if (APPLY) {
      const out = await fill.applyTripKitPlan(admin, plan, deps)
      line.applied = { applied: out.applied, skipped: out.skipped, kitSaved: out.kitSaved }
      await fill.recordDailyUse(admin, new Date(), budget.usedToday, b.used)
      const fresh = await getPackageById(live.id)
      console.log(`${live.slug}: now status=${fresh?.status}`)
    }
    report.push(line)
    console.log(JSON.stringify(line, null, 1))
  }
  fs.writeFileSync(APPLY ? 'docs/factory/trip-kit-cutoff-fix-applied.json' : 'docs/factory/trip-kit-cutoff-fix-dryrun.json', JSON.stringify({ at: new Date().toISOString(), trips: report }, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
