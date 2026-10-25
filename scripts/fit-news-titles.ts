// One-off backfill for the 60 character title rule: shortens existing news post titles (slug starts "news-") and makes duplicates unique.
//   DRY RUN (default): read only. Prints before and after for every post that is over 60 characters as Google shows it, or shares a title.
//   --apply          : writes docs/factory/news-title-fit-before.json (the rows as they are now), then changes ONLY title / meta_title,
//                      through the same logged path as the site crawl heal (content_edits row first, then the update, Undo-able
//                      from the Self-healing card). Never changes status, body or publish date.
// Run: pnpm dlx tsx scripts/fit-news-titles.ts [--apply]
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

const APPLY = process.argv.includes('--apply')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  const { getSupabaseAdmin } = await import('../lib/supabase-admin')
  const { planPostTitle } = await import('../lib/title-fit')
  const { SITE_NAME } = await import('../lib/site')
  const { applyEdit } = await import('../lib/site-crawl-run')
  const { editsLoggable } = await import('../lib/content-edits')
  const admin = getSupabaseAdmin()

  const { data, error } = await admin.from('posts').select('*').like('slug', 'news-%').order('publish_date', { ascending: true, nullsFirst: true }).limit(2000)
  if (error) throw new Error(`could not read posts: ${error.message}`)
  const { data: allPosts, error: e2 } = await admin.from('posts').select('slug, title, meta_title').limit(5000)
  if (e2) throw new Error(`could not read posts: ${e2.message}`)
  const rows = (data ?? []) as Record<string, unknown>[]
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const shownOf = (t: string, m: string) => m.trim() || `${t} | ${SITE_NAME}`

  // Search titles of every post, by slug; kept up to date as the plan is made so two renamed posts cannot collide.
  const shown = new Map<string, string>()
  for (const r of (allPosts ?? []) as { slug: string; title: string | null; meta_title: string | null }[]) shown.set(r.slug, norm(shownOf(r.title ?? '', r.meta_title ?? '')))

  const plans: { row: Record<string, unknown>; before: { title: string; meta_title: string }; after: { title: string; meta_title: string | null }; titleChanged: boolean; metaChanged: boolean }[] = []
  for (const row of rows) {
    const slug = str(row.slug)
    const others = new Set([...shown].filter(([s]) => s !== slug).map(([, v]) => v))
    const plan = planPostTitle({ slug, title: str(row.title), meta_title: str(row.meta_title), publish_date: str(row.publish_date) }, others, SITE_NAME)
    if (!plan.titleChanged && !plan.metaChanged) continue
    plans.push({ row, before: { title: str(row.title), meta_title: str(row.meta_title) }, after: { title: plan.title, meta_title: plan.meta_title }, titleChanged: plan.titleChanged, metaChanged: plan.metaChanged })
    shown.set(slug, norm(shownOf(plan.title, plan.meta_title ?? '')))
  }

  console.log(`${rows.length} news posts read. ${plans.length} need a change (${APPLY ? 'APPLY' : 'DRY RUN, nothing is written'}).\n`)
  for (const p of plans) {
    const b = shownOf(p.before.title, p.before.meta_title)
    const a = shownOf(p.after.title, p.after.meta_title ?? '')
    console.log(`/blog/${str(p.row.slug)}  [${str(p.row.status)}]`)
    console.log(`  title  before (${p.before.title.length}): ${p.before.title}`)
    console.log(`  title  after  (${p.after.title.length}): ${p.after.title}`)
    console.log(`  shown  before (${b.length}): ${b}`)
    console.log(`  shown  after  (${a.length}): ${a}\n`)
  }
  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to write.')
    return
  }
  if (!(await editsLoggable(admin))) throw new Error('the edit log (content_edits) cannot be read, so nothing is changed')
  fs.mkdirSync(path.join(process.cwd(), 'docs', 'factory'), { recursive: true })
  const snap = path.join(process.cwd(), 'docs', 'factory', 'news-title-fit-before.json')
  fs.writeFileSync(snap, JSON.stringify(plans.map((p) => ({ id: p.row.id, slug: p.row.slug, status: p.row.status, title: p.before.title, meta_title: p.before.meta_title || null, updated_at: p.row.updated_at })), null, 2))
  console.log(`Before-snapshot written to ${snap}`)
  let done = 0
  for (const p of plans) {
    const slug = str(p.row.slug)
    const base = { content_type: 'post' as const, content_id: p.row.id as string, path: `/blog/${slug}`, reason: 'Title rule: titles are at most 60 characters (news title backfill)', method: 'fixer' as const, published_after: false, cost_usd: 0 }
    const edits = []
    const columns: Record<string, unknown> = {}
    if (p.titleChanged) {
      edits.push({ ...base, field: 'title' as const, before: p.before.title, after: p.after.title })
      columns.title = p.after.title
    }
    if (p.metaChanged) {
      edits.push({ ...base, field: 'meta_title' as const, before: p.before.meta_title, after: p.after.meta_title ?? '' })
      columns.meta_title = p.after.meta_title
    }
    const res = await applyEdit(admin, { type: 'post', row: p.row, path: `/blog/${slug}` }, edits, columns)
    if (res.ok) done++
    else console.log(`  left alone ${slug}: ${res.note}`)
  }
  console.log(`\nChanged ${done} of ${plans.length}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
