// Before and after scores for every trip: "before" from docs/factory/trip-kit-backfill-before.json, "after" from the live rows.
// Read-only. Run: pnpm dlx tsx scripts/score-trip-kit.ts
import fs from 'node:fs'

for (const line of fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
}

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { getAllPackagesAdmin } = await import('../lib/packages')
  const { buildSiteIndex } = await import('../lib/content-heal-run')
  const { scoreTrip } = await import('../lib/trip-kit-fill')
  const admin = getSupabaseAdmin()
  const site = await buildSiteIndex(admin)
  const snap = JSON.parse(fs.readFileSync('docs/factory/trip-kit-backfill-before.json', 'utf8')) as { trips: { id: string; slug: string; row: Record<string, unknown> }[] }
  const before = new Map(snap.trips.map((t) => [t.id, t.row]))
  const rows = []
  for (const p of await getAllPackagesAdmin()) {
    const b = before.get(p.id)
    const sb = b ? scoreTrip({ ...(b as object), id: p.id } as typeof p, site.existing) : null
    const sa = scoreTrip(p, site.existing)
    rows.push({ slug: p.slug, status: p.status, completenessBefore: sb?.completeness.score ?? null, completenessAfter: sa.completeness.score, seoBefore: sb?.seo.score ?? null, seoAfter: sa.seo.score, pass: sa.completeness.score >= 75 && sa.seo.score >= 80, stillMissing: sa.completeness.reasons })
  }
  console.table(rows.map(({ stillMissing, ...r }) => r))
  for (const r of rows) if (r.stillMissing.length) console.log(`${r.slug}: ${r.stillMissing.join('; ')}`)
  fs.writeFileSync('docs/factory/trip-kit-backfill-summary.json', JSON.stringify({ at: new Date().toISOString(), trips: rows }, null, 1))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
