// Admin-safe, on demand: give every PUBLISHED guide whose hero photo is a duplicate, missing, tiny or a wrong subject a fresh, relevant stock
// photo. This is the same code the daily heal runs (lib/guide-photo-run.ts), but it tries every search variant now instead of two a day.
//
//   pnpm dlx tsx scripts/heal-guide-photos.ts                          (DRY RUN, the default: prints the chosen photo and alt text per guide, writes nothing)
//   pnpm dlx tsx scripts/heal-guide-photos.ts --yes                    (saves the photos; every change is logged and can be undone on the Content edits page)
//   pnpm dlx tsx scripts/heal-guide-photos.ts --limit=5                (only the first 5 flagged guides)
//   pnpm dlx tsx scripts/heal-guide-photos.ts --only=cruise-lines/celebrity-cruises   (one guide: kind/slug; a guide with a good photo is left alone)
//   pnpm dlx tsx scripts/heal-guide-photos.ts --probe                  (also fetch each stored hero to find broken ones: slower)
//
// A dry run does search Pexels (free) so the choice can be reviewed, but writes nothing, records no photo history and never calls the AI
// illustration. A write run saves the new address and alt text through the content_edits log (needs migration 0052), and writes
// heal-guide-photos-<time>.json (what was chosen for every guide) next to where you ran it; the old photo of each guide is in the audit log.
// The alt text is honest: "Illustrative stock photo: <type of thing>, <place>". It never names the ship or property.
// The AI illustration is used only if the existing admin switch is already ON (autoblog_ai_image_fallback) and OPENAI_API_KEY is set, and only
// when every search variant failed. This script never turns the switch on.
//
// Needs SUPABASE_SERVICE_ROLE_KEY and PEXELS_API_KEY in .env.local (found in the current folder or any folder above it).
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

async function main() {
  const apply = process.argv.includes('--yes')
  const probe = process.argv.includes('--probe')
  const only = argValue('only')
  const limitArg = argValue('limit')
  const limit = limitArg === null ? undefined : Number(limitArg)
  if (limit !== undefined && !(limit > 0)) {
    console.error('--limit must be a positive whole number')
    process.exit(1)
  }
  if (only !== null && !/^[a-z-]+\/[a-z0-9-]+$/i.test(only)) {
    console.error('--only must look like kind/slug, for example cruise-lines/celebrity-cruises')
    process.exit(1)
  }

  const envFile = loadEnvLocal()
  console.log(envFile ? `Using ${envFile}` : 'No .env.local found; using the environment as it is.')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local and run again.')
    process.exit(1)
  }
  console.log(apply ? 'WRITE RUN: the photos below will be saved.' : 'DRY RUN: nothing is written. Add --yes to save.')

  // Imported only now, after the environment is loaded (the Supabase client reads it when its module loads).
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { runGuidePhotoHeal } = await import('../lib/guide-photo-run')

  const report = await runGuidePhotoHeal(getSupabaseAdmin(), { apply, limit, only, probe, daily: false })

  console.log(`${report.flagged} published guide${report.flagged === 1 ? '' : 's'} have a duplicate, missing, tiny or wrong-subject photo.`)
  if (report.note) console.log(report.note)
  for (const r of report.results) {
    console.log('')
    console.log(`${r.kind}/${r.slug}  (${r.name})`)
    console.log(`  why:     ${r.problems}`)
    console.log(`  result:  ${r.outcome}${r.source ? ` (${r.source})` : ''}`)
    if (r.url) console.log(`  photo:   ${r.url}`)
    if (r.alt) console.log(`  alt:     ${r.alt}`)
    if (r.query) console.log(`  search:  ${r.query}`)
    console.log(`  note:    ${r.note}`)
  }
  for (const p of report.problems) console.log(`PROBLEM: ${p}`)

  if (apply) {
    const file = `heal-guide-photos-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    writeFileSync(file, JSON.stringify(report.results, null, 2))
    console.log(`\nSaved ${report.fixed} of ${report.results.length}. Report written to ${file}`)
  } else {
    console.log('\nNothing was written.')
  }
  if (report.problems.length) process.exit(1)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
