// Offline checks for the titled social cover helpers (lib/social-cover.ts): headline shortener, text fitting,
// image-pick gate and URL builder. No network, no fonts. Run: pnpm dlx tsx scripts/check-social-cover.ts
import {
  shortenCoverTitle,
  shortenNewsHeadline,
  fitCoverTitle,
  fitNewsText,
  fitText,
  pickPostImage,
  socialCoverUrl,
  isValidCoverSlug,
  isSocialCoverKind,
  verifyCoverUrl,
  COVER_TITLE_MAX_CHARS,
  COVER_BLOCK_MAX_WIDTH,
  COVER_BLOCK_PAD_X,
  COVER_FONT_MIN,
  COVER_FONT_MAX,
  CAPS_WIDTH_RATIO,
  COVER_WIDTH,
  COVER_SAFE_SIDE,
  MIXED_WIDTH_RATIO,
} from '../lib/social-cover'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const DANGLING = /\b(a|an|the|to|of|in|on|at|for|and|or|but|with|from|by|as|into|vs|your|our)$/i
const wc = (s: string) => s.split(/\s+/).filter(Boolean).length

// ---- shortener ----
const titles = [
  'Best Time to Visit Santorini: Month by Month Weather and Crowds',
  '7-Night Alaska Cruise from Seattle',
  'The Ultimate Guide to Visiting Santorini in Spring',
  'Is Mexico Safe to Travel To? What Canadians Need to Know Before They Go',
  'Cruise vs Resort: Which All Inclusive Holiday Is Right for You',
  'Bali',
  'Hawaii: A Complete Beginner Guide for First-Time Visitors to the Islands',
  'How to Pack Light for a Two Week Europe Trip With Only a Carry On Bag',
  'Sandals Royal Barbados | TravelFunBiz.ca',
  'Maldives Overwater Villas, Honeymoon Packages and Dreamy Beaches from Toronto',
  'Why Everyone Is Talking About the New Disney Cruise Ship Launching in Florida This Winter and Beyond',
]
for (const t of titles) {
  const s = shortenCoverTitle(t, 'TravelFunBiz.ca')
  check(`short title for "${t.slice(0, 40)}": ${s}`, s !== '' && s.length <= COVER_TITLE_MAX_CHARS && wc(s) <= 6 && s === s.toUpperCase() && !DANGLING.test(s), s)
  check(`  is deterministic`, shortenCoverTitle(t, 'TravelFunBiz.ca') === s)
}
check('keeps a whole short title intact', shortenCoverTitle('7-Night Alaska Cruise from Seattle') === '7-NIGHT ALASKA CRUISE FROM SEATTLE')
check('takes a whole phrase before a colon, not a word slice', shortenCoverTitle('Best Time to Visit Santorini: Month by Month Weather and Crowds') === 'BEST TIME TO VISIT SANTORINI', shortenCoverTitle('Best Time to Visit Santorini: Month by Month Weather and Crowds'))
check('drops "Ultimate Guide to" filler', shortenCoverTitle('The Ultimate Guide to Visiting Santorini in Spring') === 'VISITING SANTORINI IN SPRING', shortenCoverTitle('The Ultimate Guide to Visiting Santorini in Spring'))
check('strips the site name suffix', !shortenCoverTitle('Sandals Royal Barbados | TravelFunBiz.ca', 'TravelFunBiz.ca').includes('TRAVELFUNBIZ'))
check('empty title gives empty string', shortenCoverTitle('') === '' && shortenCoverTitle('   ') === '')
check('single word title is kept', shortenCoverTitle('Bali') === 'BALI')
check('never ends on a preposition after trimming', !DANGLING.test(shortenCoverTitle('Planning Your Trip to the Beautiful Island of Santorini in the Aegean Sea Greece')))
check('removes emoji', !/[\u{1F000}-\u{1FFFF}]/u.test(shortenCoverTitle('Sun, Sand and Sea \u{1F334} Caribbean Escapes This Winter')))

// ---- fitting ----
const MAX_INNER = COVER_BLOCK_MAX_WIDTH - COVER_BLOCK_PAD_X * 2
for (const t of titles) {
  const s = shortenCoverTitle(t, 'TravelFunBiz.ca')
  const f = fitCoverTitle(s)
  const widest = Math.max(...f.lines.map((l) => l.length)) * f.fontSize * CAPS_WIDTH_RATIO
  check(`fit "${s}" -> ${f.fontSize}px x ${f.lines.length}`, f.complete && f.lines.length <= 3 && f.fontSize >= COVER_FONT_MIN && f.fontSize <= COVER_FONT_MAX && widest <= MAX_INNER, `${widest} > ${MAX_INNER}`)
}
check('short title uses a big font', fitCoverTitle('BALI').fontSize === COVER_FONT_MAX)
check('3-word title still big', fitCoverTitle('MALDIVES FOR TWO').fontSize >= 96, String(fitCoverTitle('MALDIVES FOR TWO').fontSize))
check('long title shrinks but stays within 3 lines', (() => { const f = fitCoverTitle('SANDALS ROYAL BARBADOS RESORT TRIP'); return f.lines.length <= 3 && f.fontSize < COVER_FONT_MAX })())
check('lines never lose words', (() => { const s = 'BEST TIME TO VISIT SANTORINI'; return fitCoverTitle(s).lines.join(' ') === s })())
check('36-char worst case fits in 3 lines at 72px or more', (() => { const f = fitCoverTitle('ABCDEFGHIJ KLMNOPQRST UVWXYZABCDE'); return f.complete && f.lines.length <= 3 })())
check('an impossible word is reported incomplete, not thrown', fitText('SUPERCALIFRAGILISTICEXPIALIDOCIOUS', { innerWidth: 400, maxSize: 120, minSize: 72, maxLines: 3, widthRatio: 0.7 }).complete === false)

// ---- news ----
const longNews = 'Canada issues new travel advisory for several Caribbean islands as hurricane season peaks and airlines warn of delays to many flights this week'
const n = shortenNewsHeadline(longNews)
check('news headline is at most 14 words', wc(n) <= 14 && wc(n) >= 3, n)
check('news headline does not end on a dangling word', !DANGLING.test(n), n)
check('short news headline unchanged', shortenNewsHeadline('Air Canada resumes flights to Cancun') === 'Air Canada resumes flights to Cancun')
const nf = fitNewsText(n)
check('news text fits within safe width', nf.complete && Math.max(...nf.lines.map((l) => l.length)) * nf.fontSize * (MIXED_WIDTH_RATIO + 0.04) <= COVER_WIDTH - COVER_SAFE_SIDE * 2 && nf.lines.length <= 6, `${nf.fontSize}px ${nf.lines.length} lines`)
check('news empty headline gives empty string', shortenNewsHeadline('') === '')

// ---- URL + gate ----
check('url builder', socialCoverUrl('https://travelfunbiz.ca/', 'blog', 'my-post') === 'https://travelfunbiz.ca/social-cover/blog/my-post')
check('url encodes the slug', socialCoverUrl('https://x.test', 'guide', 'a b') === 'https://x.test/social-cover/guide/a%20b')
check('slug validation', isValidCoverSlug('guide-hotels-sandals-royal') && !isValidCoverSlug('../x') && !isValidCoverSlug('a/b') && !isValidCoverSlug('') && !isValidCoverSlug('a..b'))
check('kind validation', isSocialCoverKind('news') && isSocialCoverKind('trip') && !isSocialCoverKind('og'))
{
  const base = 'https://travelfunbiz.ca'
  const p = pickPostImage({ base, kind: 'blog', slug: 'my-post', title: 'Best Time to Visit Santorini', coverUrl: 'https://images.pexels.com/photos/1/x.jpeg' })
  check('gate: a titled post never sends the bare photo', p.composed && p.url === `${base}/social-cover/blog/my-post`)
  const q = pickPostImage({ base, kind: 'news', slug: 'news-abc', title: 'Air Canada resumes flights', coverUrl: null })
  check('gate: a news post with no photo gets a composed card', q.composed && !!q.url)
  const r = pickPostImage({ base, kind: 'blog', slug: 'my-post', title: '', coverUrl: 'https://images.pexels.com/photos/1/x.jpeg' })
  check('fallback: no title -> raw photo', !r.composed && r.url === 'https://images.pexels.com/photos/1/x.jpeg')
  const s = pickPostImage({ base, kind: 'blog', slug: '../bad', title: 'Fine title here', coverUrl: 'https://images.pexels.com/photos/1/x.jpeg' })
  check('fallback: unusable slug -> raw photo', !s.composed && s.url === 'https://images.pexels.com/photos/1/x.jpeg')
  const t = pickPostImage({ base, kind: 'blog', slug: 'my-post', title: null, coverUrl: null })
  check('nothing to send -> null', t.url === null && !t.composed)
}

// ---- verifyCoverUrl (injected fetch) ----
async function run() {
  const png = new Uint8Array(2000)
  const mk = (status: number, type: string, body: Uint8Array = png) => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch
  check('verify: good PNG', (await verifyCoverUrl('https://x.test/a', mk(200, 'image/png'))) === true)
  check('verify: 404 fails', (await verifyCoverUrl('https://x.test/a', mk(404, 'text/plain'))) === false)
  check('verify: 503 fails', (await verifyCoverUrl('https://x.test/a', mk(503, 'text/plain'))) === false)
  check('verify: html fails', (await verifyCoverUrl('https://x.test/a', mk(200, 'text/html'))) === false)
  check('verify: tiny body fails', (await verifyCoverUrl('https://x.test/a', mk(200, 'image/png', new Uint8Array(10)))) === false)
  check('verify: throw fails closed', (await verifyCoverUrl('https://x.test/a', (async () => { throw new Error('boom') }) as unknown as typeof fetch)) === false)
  if (failures) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll social cover checks passed')
}
run()
