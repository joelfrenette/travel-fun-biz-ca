// Admin-safe, one-off: give every PUBLISHED post and guide a good cover and alt text. A good cover is never overwritten.
//
//   pnpm dlx tsx scripts/backfill-covers.ts                 (DRY RUN, the default: reads and prints the plan, writes nothing)
//   pnpm dlx tsx scripts/backfill-covers.ts --yes           (writes the plan)
//   pnpm dlx tsx scripts/backfill-covers.ts --limit=20      (only the first 20 changes)
//   pnpm dlx tsx scripts/backfill-covers.ts --no-probe      (do not fetch the stored covers: skips the broken/tiny check)
//   pnpm dlx tsx scripts/backfill-covers.ts --yes --pexels  (try the ranked Pexels selector first; needs PEXELS_API_KEY; writes the 30-photo history)
//
// What it changes (lib/cover-backfill.ts, lib/image-quality.ts):
//   - a post with no cover, an SVG or default thumbnail, a broken or tiny image, a wrong-subject alt, or the same picture as an
//     earlier post gets its branded 1200x630 card (/og/blog/<slug>, or the teal news card /og/news/<slug> for a news post);
//   - a post or guide with missing or generic alt text gets a descriptive one;
//   - a guide with a bad hero is only LISTED ("needs-photo"): its hero is captioned as a stock photo, so a drawn card is not used.
// It never calls an AI service. Without --pexels it never calls Pexels either. On --yes it writes backfill-covers-<time>.json (before
// and after of every row) next to where you ran it, so a run can be put back by hand.
//
// Needs SUPABASE_SERVICE_ROLE_KEY in .env.local (found in the current folder or any folder above it).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function argValue(name: string): string | null {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : null
}

function loadEnvLocal(): string | null {
  let dir = resolve(process.cwd())
  for (let i = 0; i < 6; i++) {
    const file = join(dir, '.env.local')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
        if (!m || line.trim().startsWith('#')) continue
        let value = m[2]
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        if (process.env[m[1]] === undefined) process.env[m[1]] = value
      }
      return file
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n))

async function main() {
  const apply = process.argv.includes('--yes')
  const pexels = process.argv.includes('--pexels')
  const probe = !process.argv.includes('--no-probe')
  const limitArg = argValue('limit')
  const limit = limitArg === null ? undefined : Number(limitArg)
  if (limit !== undefined && !(limit > 0)) {
    console.error('--limit must be a positive whole number')
    process.exit(1)
  }
  if (pexels && !apply) {
    console.error('--pexels writes the recent-photo history, so it needs --yes. A dry run never calls Pexels.')
    process.exit(1)
  }

  const envFile = loadEnvLocal()
  console.log(envFile ? `Using ${envFile}` : 'No .env.local found; using the environment as it is.')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local and run again.')
    process.exit(1)
  }
  console.log(apply ? 'WRITE RUN: the changes below will be saved.' : 'DRY RUN: nothing is written. Add --yes to save.')

  // Imported only now, after the environment is loaded (the Supabase client reads it when its module loads).
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { runCoverBackfill } = await import('../lib/cover-backfill')
  const { findDestinationPhoto, isPexelsConfigured } = await import('../lib/pexels')
  const { coverAlt, heroAlt } = await import('../lib/image-quality')

  if (pexels && !isPexelsConfigured()) {
    console.error('PEXELS_API_KEY is not set, so --pexels cannot search. Add it to .env.local or drop --pexels.')
    process.exit(1)
  }

  const admin = getSupabaseAdmin()
  const report = await runCoverBackfill(admin, {
    apply,
    probe,
    pexels,
    limit,
    selector: pexels
      ? async (row) => {
          const photo = await findDestinationPhoto(row.title)
          if (!photo) return null
          return { cover: photo.url, alt: row.table === 'guides' ? heroAlt(photo.alt, row.title) : coverAlt({ title: row.title, keyword: row.title, photoAlt: photo.alt }) }
        }
      : undefined,
  })

  console.log(`Scanned ${report.scanned.posts} published posts and ${report.scanned.guides} published guides. ${report.actions.length} need a change.`)
  console.log(`${pad('TABLE', 7)}${pad('SOURCE', 14)}${pad('SLUG', 52)}WHY`)
  for (const a of report.actions) console.log(`${pad(a.table, 7)}${pad(a.source, 14)}${pad(a.slug, 52)}${a.reasons.join('; ')}`)

  if (apply) {
    const file = `backfill-covers-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    writeFileSync(file, JSON.stringify(report.actions.map((a) => ({ table: a.table, id: a.id, slug: a.slug, before: a.before, set: a.set })), null, 2))
    console.log(`Applied ${report.applied}. Skipped ${report.skipped.length}. Failed ${report.failed.length}. Before/after saved to ${file}`)
    for (const f of report.failed) console.log(`  failed: ${f.slug}: ${f.error}`)
    for (const s of report.skipped) console.log(`  skipped: ${s}`)
  } else {
    console.log('Nothing was written.')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
