// Offline checks for the WP2 caption gate and style rotation. No network, no database.
// Run: pnpm dlx tsx scripts/check-captions.ts   (exits 1 on the first failed expectation)
import { captionProblems } from '../lib/social-captions'
import { rotateStyle, HOOK_STYLES, valuesFromRows, ungroundedNumbers } from '../lib/hook-styles'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const link = 'https://travelfunbiz.ca/blog/rhine-river-cruise?utm_source=x&utm_medium=social&utm_campaign=rhine&utm_content=question'
const base = { title: 'Rhine River Cruise: What First Timers Should Know', summary: 'A plain guide to a 7 day Rhine cruise.', network: 'facebook', link, grounding: null as string | null }
const good = `Is a river cruise right for your first big trip?\n\nThis guide walks through what a 7 day Rhine sailing is like for a first timer.\n\nRead the full guide:\n${link}`

expect('clean caption has no problems', captionProblems(good, base).length === 0, captionProblems(good, base).join('; '))
expect('over limit flagged', captionProblems(good + ' x'.repeat(200), { ...base, network: 'x' }).some((p) => p.includes('limit')))
expect('title as first line flagged', captionProblems(`${base.title}\n\nSomething else that is long enough to count.\n${link}`, base).some((p) => p.includes('title')))
expect('title as prefix of first line flagged', captionProblems(`${base.title} and more words here\n\nBody text that is long enough.\n${link}`, base).some((p) => p.includes('title')))
expect('invented digit flagged', captionProblems(good.replace('first timer', 'first timer in 14 days'), base).some((p) => p.includes('14')))
expect('digit from summary is fine', captionProblems(good, base).every((p) => !p.includes('number')))
expect('spelled number flagged', captionProblems(good.replace('what a 7 day', 'what a three day'), base).some((p) => p.includes('3')))
expect('spelled number present in source is fine', ungroundedNumbers('three days', 'it takes three days').length === 0)
expect('digit matches source word', ungroundedNumbers('3 days', 'it takes three days').length === 0)
expect('hashtag digits and a 2026 year are ignored', ungroundedNumbers('Plan for 2026 #Rhine2031x', 'nothing here').length === 0)
expect('year outside 2025-2030 is flagged', ungroundedNumbers('Back in 2019', 'nothing here').join() === '2019')
expect('"Day 3 100 people" is not joined', ungroundedNumbers('Day 3 100 people', 'day 3 and 100 people').length === 0)
expect('comma grouping still joins', ungroundedNumbers('1,200 guests', 'about 1200 guests').length === 0)
expect('"one" is ignored', ungroundedNumbers('one of the best', 'nothing here').length === 0)
expect('missing link flagged on facebook', captionProblems(good.replace(link, ''), base).some((p) => p.includes('link')))
expect('missing link fine on instagram', captionProblems(good.replace(link, ''), { ...base, network: 'instagram' }).every((p) => !p.includes('link is missing')))
expect('link only flagged', captionProblems(link, { ...base, network: 'x' }).some((p) => p.includes('no text besides')))
expect('link plus hashtags only flagged', captionProblems(`#a #b\n${link}`, { ...base, network: 'x' }).some((p) => p.includes('no text besides')))
expect('em dash flagged', captionProblems(good.replace('walks', `walks ${String.fromCharCode(8212)}`), base).some((p) => p.includes('em dash')))

// Rotation
const seq: string[] = []
let recent: string[] = []
for (let i = 0; i < 21; i++) {
  const s = rotateStyle(recent, HOOK_STYLES)
  seq.push(s)
  recent = [s, ...recent].slice(0, 12)
}
expect('never repeats the previous style', seq.every((s, i) => i === 0 || s !== seq[i - 1]))
expect('all 7 styles used within 14 posts', new Set(seq.slice(0, 14)).size === 7)
expect('most recent is never chosen', rotateStyle(['story'], HOOK_STYLES) !== 'story')
expect('deterministic', rotateStyle(['story', 'mistake'], HOOK_STYLES) === rotateStyle(['story', 'mistake'], HOOK_STYLES))
const firsts = [0, 1, 2, 3].map((i) => rotateStyle([], HOOK_STYLES, i))
expect('empty history differs per network offset', new Set(firsts).size === 4, firsts.join(','))
expect('single-entry catalogue works', rotateStyle(['a'], ['a'] as const) === 'a')

// History ordering: the hook_style_at stamp wins over updated_at
const rows = [
  { variant_tags: { 'hook_style:x': 'old' }, updated_at: '2026-10-09T10:00:00Z' },
  { variant_tags: { 'hook_style:x': 'new', hook_style_at: '2026-10-09T09:00:00Z' }, updated_at: '2026-10-09T08:00:00Z' },
  { variant_tags: { 'hook_style:x': 'older', hook_style_at: '2026-10-01T09:00:00Z' }, updated_at: '2026-10-09T11:00:00Z' },
]
expect('stamp orders history, newest first', valuesFromRows(rows, 'hook_style:x', 3).join(',') === 'old,new,older', valuesFromRows(rows, 'hook_style:x', 3).join(','))

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
