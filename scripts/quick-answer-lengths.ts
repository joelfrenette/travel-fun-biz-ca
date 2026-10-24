// One-off, READ ONLY: prints the word count of the "Quick answer" line of every published post, so the 15 to 60 word range in
// lib/blog-quality.ts (QUICK_ANSWER_MIN_WORDS / MAX_WORDS) can be checked against the real spread. Needs the Supabase env vars.
//   pnpm dlx tsx scripts/quick-answer-lengths.ts
import { getSupabaseAdmin } from '../lib/supabase-admin'
import { QUICK_ANSWER_MAX_WORDS, QUICK_ANSWER_MIN_WORDS, quickAnswerWords } from '../lib/blog-quality'

async function main() {
  const { data, error } = await getSupabaseAdmin().from('posts').select('slug, body').eq('status', 'published')
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as { slug: string; body: string }[]).map((p) => ({ slug: p.slug, words: quickAnswerWords(p.body ?? '') }))
  for (const r of rows.sort((a, b) => (a.words ?? -1) - (b.words ?? -1))) {
    const flag = r.words === null ? 'NONE' : r.words < QUICK_ANSWER_MIN_WORDS ? 'SHORT' : r.words > QUICK_ANSWER_MAX_WORDS ? 'LONG' : 'ok'
    console.log(`${String(r.words ?? '-').padStart(4)}  ${flag.padEnd(5)}  ${r.slug}`)
  }
  const have = rows.filter((r) => r.words !== null).map((r) => r.words as number)
  console.log(`\n${rows.length} posts, ${have.length} with a Quick answer. Range now ${QUICK_ANSWER_MIN_WORDS} to ${QUICK_ANSWER_MAX_WORDS}; outside it: ${have.filter((w) => w < QUICK_ANSWER_MIN_WORDS || w > QUICK_ANSWER_MAX_WORDS).length}.`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
