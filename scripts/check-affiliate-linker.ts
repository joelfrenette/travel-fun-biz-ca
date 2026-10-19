// Offline check for WP22 "one affiliate list + word linker": the display-time linker (longest phrase first, first-N rule,
// 6 per page, casing, whole words, never inside links/headings/code/alt/JSON-LD/FAQ questions), hostile phrases and
// content, 200-rule performance, OFF links and OFF rules, the /go href, the disclosure, fail-open reads, scope,
// no mutation of input, the usage report, the admin routes and the migration. In-memory only, no network.
// Run: pnpm dlx tsx scripts/check-affiliate-linker.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  compileRules, linkKeywords, linkPage, linkTextParts, newLinkerState, cleanPhrase, phraseProblem, scopeMatches,
  MAX_LINKS_PER_PAGE, MAX_RULES, type AffiliateRule, type PageContext,
} from '../lib/affiliate-linker'
import { loadAffiliateRules, clearAffiliateRulesCache, rowsToRules, normalizeKeywordInput, isMissingKeywordsTable, KEYWORDS_MIGRATION_MESSAGE, RULES_TTL_MS } from '../lib/affiliate-rules'
import { AffiliateParts, AffiliateAutoDisclosure } from '../components/affiliate-text'
import { linkedGuideContent, GuideArticle, GuideFaqList } from '../components/guide-parts'
import { buildUsageReport, fitReport, previewRule, rescanSite, loadStoredReport, staticUsageDocs, USAGE_SETTING_KEY, MAX_USAGE_DOCS, MAX_REPORT_BYTES, PREVIEW_SHOWN, type UsageDoc } from '../lib/affiliate-usage'
import { refreshAfterChange, resetUsageDebounce, flushPendingUsage, usageRefreshPending, USAGE_MIN_GAP_MS } from '../lib/affiliate-refresh'
import { createKeyword, updateKeyword, deleteKeyword, previewKeyword, listKeywords, phraseConflict } from '../lib/affiliate-keyword-actions'
import { fakeAdmin, type Db } from './fake-admin'
import { DEFAULT_DISCLOSURE } from '../lib/affiliate-partners'
import { translate } from '../lib/i18n'

;(globalThis as unknown as { React: typeof React }).React = React

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

let n = 0
const rule = (phrase: string, slug = 'viator', extra: Partial<AffiliateRule> = {}): AffiliateRule => ({ id: `r${++n}`, phrase, slug, scope: 'all', max_per_page: 1, ...extra })
const link = (html: string, rules: AffiliateRule[] | null | undefined, ctx: PageContext = 'blog', extra: Partial<Parameters<typeof linkKeywords>[2]> = {}) => linkKeywords(html, rules, { context: ctx, ...extra })
const anchors = (html: string) => [...html.matchAll(/<a [^>]*data-affiliate-auto[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1])
const strip = (html: string) => html.replace(/<a [^>]*data-affiliate-auto[^>]*>([\s\S]*?)<\/a>/g, '$1')

async function main() {
  // ---------- 1. basics ----------
  const basic = link('<p>Book Croatia tours early. Croatia tours sell out.</p>', [rule('croatia tours')])
  expect('links the phrase, keeps the original casing as the link text', basic.output.includes('>Croatia tours</a>') && anchors(basic.output).length === 1)
  expect('only the first occurrence is linked (max_per_page 1)', anchors(basic.output).length === 1 && basic.output.endsWith('Croatia tours sell out.</p>'))
  expect('the href is our /go short route, opens in a new tab, sponsored nofollow noopener', basic.output.includes('href="/go/viator"') && basic.output.includes('target="_blank"') && basic.output.includes('rel="sponsored nofollow noopener"'))
  expect('never a raw external URL in the output', !/https?:\/\//.test(basic.output))
  const three = link('<p>tours tours tours tours</p>', [rule('tours', 'vi', { max_per_page: 3 })])
  expect('max_per_page 3 links the first three only', anchors(three.output).length === 3 && three.output.endsWith('</a> tours</p>'))
  const clamp = link('<p>tours tours tours tours tours</p>', [rule('tours', 'vi', { max_per_page: 99 })])
  expect('max_per_page is clamped to 3', anchors(clamp.output).length === 3)
  expect('whole words only: "tours" is not linked inside "tourism" or "detours"', anchors(link('<p>tourism and detours and tours</p>', [rule('tours')]).output).length === 1 && link('<p>tourism detours</p>', [rule('tours')]).count === 0)
  expect('"Croatia tours" is not linked inside "Croatia toursim"', link('<p>Croatia toursim</p>', [rule('Croatia tours')]).count === 0 && link('<p>Croatia tours-and more</p>', [rule('Croatia tours')]).count === 1)
  expect('case-insensitive: CROATIA TOURS and croatia tours both match', link('<p>CROATIA TOURS</p>', [rule('Croatia Tours')]).output.includes('>CROATIA TOURS</a>'))
  expect('spaces in a phrase match any run of whitespace', link('<p>Croatia\n  tours</p>', [rule('Croatia tours')]).count === 1)
  const longest = link('<p>Croatia tours from Split</p>', [rule('Croatia', 'short'), rule('Croatia tours', 'long')])
  expect('the longest phrase wins when two overlap', longest.output.includes('href="/go/long"') && !longest.output.includes('/go/short'))
  const second = link('<p>Croatia and Croatia tours</p>', [rule('Croatia', 'short'), rule('Croatia tours', 'long')])
  expect('shorter phrase still links where the longer one does not match', second.output.includes('href="/go/short" ') && second.output.includes('href="/go/long" ') && anchors(second.output).join('|') === 'Croatia|Croatia tours')
  expect('text with an entity beside the phrase is kept as is', link('<p>Fish &amp; chips tours</p>', [rule('chips tours')]).output === '<p>Fish &amp; <a href="/go/viator" target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>chips tours</a></p>')
  expect('"amp" is not linked inside &amp;', link('<p>R&amp;B</p>', [rule('amp')]).count === 0)

  // ---------- 2. never inside ----------
  const R = [rule('croatia tours')]
  const none = (html: string) => link(html, R).count === 0 && link(html, R).output === html
  expect('never inside an existing link', none('<p><a href="/x">Croatia tours</a></p>') && none('<p><a href="/x"><strong>Croatia tours</strong></a></p>'))
  expect('never inside headings h1 to h6', [1, 2, 3, 4, 5, 6].every((i) => none(`<h${i}>Croatia tours</h${i}>`)))
  expect('never inside a button, code, pre, textarea, select, label', ['button', 'code', 'pre', 'textarea', 'select', 'label'].every((t) => none(`<${t}>Croatia tours</${t}>`)))
  expect('never inside a FAQ question (summary)', none('<details><summary>Do Croatia tours run in winter?</summary></details>'))
  expect('never inside JSON-LD or other scripts and styles', none('<script type="application/ld+json">{"name":"Croatia tours"}</script>') && none('<style>.x::after{content:"Croatia tours"}</style>'))
  expect('never inside the image alt text or any attribute', none('<img src="/a.jpg" alt="Croatia tours">') && none('<p title="Croatia tours" data-x=\'Croatia tours\'>no</p>'))
  expect('never inside an HTML comment', none('<p><!-- Croatia tours --></p>'))
  expect('text after a closed link is linked again', link('<p><a href="/x">a</a> Croatia tours</p>', R).count === 1)
  expect('after a heading closes, the next paragraph links', link('<h2>Croatia tours</h2><p>Croatia tours</p>', R).output.startsWith('<h2>Croatia tours</h2><p><a'))
  expect('an unclosed link tag fails safe (nothing after it is linked)', link('<p><a href="/x">open Croatia tours', R).count === 0)
  expect('never inside another auto-link (run twice is a no-op)', (() => { const once = link('<p>Croatia tours</p>', R); return link(once.output, R).output === once.output })())
  expect('a self-closing or void tag does not hide the text after it', link('<p><br/>Croatia tours <img alt="x"> Croatia tours</p>', R).count === 1)

  // ---------- 3. page limits ----------
  const many = Array.from({ length: 10 }, (_, i) => rule(`place${i}x`, `slug-${i}`))
  const ten = link(`<p>${many.map((r) => r.phrase).join(' ')}</p>`, many)
  expect('at most 6 automatic links on one page, document order wins', ten.count === MAX_LINKS_PER_PAGE && anchors(ten.output).join(',') === 'place0x,place1x,place2x,place3x,place4x,place5x')
  const st = newLinkerState()
  const a1 = link('<p>place0x place1x place2x</p>', many, 'blog', { state: st })
  const a2 = link('<p>place3x place4x place5x place6x place7x</p>', many, 'blog', { state: st })
  expect('the cap and the first-occurrence rule cover several texts of one page when they share a state', a1.count === 3 && a2.count === 3 && st.total === 6)
  const a3 = link('<p>place0x</p>', many, 'blog', { state: newLinkerState() })
  expect('a fresh page state starts at zero', a3.count === 1)
  expect('the page cap can be lowered but never raised above 6', link('<p>place0x place1x</p>', many, 'blog', { pageCap: 1 }).count === 1 && link(`<p>${many.map((r) => r.phrase).join(' ')}</p>`, many, 'blog', { pageCap: 50 }).count === 6)
  const page = linkPage({ bodyHtml: '<p>Croatia tours</p>', faqAnswers: ['Do Croatia tours run? Yes, Croatia tours do.'] }, R, 'blog')
  expect('a phrase linked in the body is not linked again in the FAQ (one occurrence per page)', page.count === 1 && page.faq[0].every((p) => typeof p === 'string'))
  const page2 = linkPage({ bodyHtml: '<p>Nothing here</p>', faqAnswers: ['We love Croatia tours.'] }, R, 'blog')
  expect('FAQ answers link when the body did not', page2.count === 1 && page2.faq[0].some((p) => typeof p !== 'string'))

  // ---------- 4. OFF, scope, failing open ----------
  expect('no rules: output is the input, no links', link('<p>Croatia tours</p>', []).output === '<p>Croatia tours</p>' && link('<p>x</p>', null).count === 0 && link('<p>x</p>', undefined).count === 0)
  expect('scope: blog-only rule does not link on a guide, guides rule links on destinations', link('<p>Croatia tours</p>', [rule('Croatia tours', 'vi', { scope: 'blog' })], 'guides').count === 0 && link('<p>Croatia tours</p>', [rule('Croatia tours', 'vi', { scope: 'guides' })], 'destinations').count === 1 && link('<p>Croatia tours</p>', [rule('Croatia tours', 'vi', { scope: 'guides' })], 'blog').count === 0)
  expect('scope: all applies everywhere, destinations only on destinations', (['blog', 'guides', 'destinations'] as PageContext[]).every((c) => link('<p>Croatia tours</p>', [rule('Croatia tours')], c).count === 1) && link('<p>Croatia tours</p>', [rule('Croatia tours', 'vi', { scope: 'destinations' })], 'guides').count === 0 && scopeMatches('destinations', 'destinations'))
  expect('a rule with a bad slug or phrase or scope is ignored, not an error', link('<p>Croatia tours</p>', [rule('Croatia tours', 'BAD SLUG!'), rule('x'), { ...rule('Croatia tours'), scope: 'nope' as never }]).count === 0)
  // OFF rows never reach the linker: rowsToRules drops an OFF link; the loader only asks for ON keywords.
  const joined = [
    { id: 'k1', phrase: 'Croatia tours', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'viator', status: 'active', url: 'https://merchant.shopco.com/a' } },
    { id: 'k2', phrase: 'Temptations', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'temptations', status: 'hidden', url: 'https://merchant.shopco.com/a' } },
    { id: 'k3', phrase: 'Drafty', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'drafty', status: 'draft', url: 'https://merchant.shopco.com/a' } },
    { id: 'k4', phrase: 'Lonely', scope: 'all', max_per_page: 1, affiliate_links: null },
    { id: 'k5', phrase: 'Arr', scope: 'all', max_per_page: 1, affiliate_links: [{ slug: 'arr-link', status: 'active', url: 'https://merchant.shopco.com/a' }] },
  ]
  expect('a keyword whose link is OFF (hidden or draft) or missing produces no rule', rowsToRules(joined).map((r) => r.phrase).join(',') === 'Croatia tours,Arr')
  expect('turning a link OFF removes its phrase links on the next render', (() => {
    const html = '<p>Visit Temptations and Croatia tours.</p>'
    const before = link(html, rowsToRules(joined.map((j) => (j.id === 'k2' ? { ...j, affiliate_links: { slug: 'temptations', status: 'active', url: 'https://merchant.shopco.com/a' } } : j))))
    const after = link(html, rowsToRules(joined))
    return before.output.includes('/go/temptations') && !after.output.includes('/go/temptations') && after.output.includes('/go/viator')
  })())
  expect('editing a link URL does not change the rendered href (it is /go/<slug>)', (() => {
    const rows = (url: string) => rowsToRules([{ id: 'k', phrase: 'Croatia tours', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'viator', status: 'active', url } as never }])
    return link('<p>Croatia tours</p>', rows('https://old.example.com/a')).output === link('<p>Croatia tours</p>', rows('https://new.example.com/b')).output
  })())

  const placeholderRows = ['https://', 'https://example.com/REPLACE', 'REPLACE', '', null, 'https://your-link.shopco.com'].map((url, i) => ({ id: `p${i}`, phrase: `Place ${i}`, scope: 'all', max_per_page: 1, affiliate_links: { slug: 'viator', status: 'active', url } }))
  expect('an ON link with an empty or placeholder address gets no word links (they would land on the home page)', rowsToRules(placeholderRows as never).length === 0)
  clearAffiliateRulesCache()
  const ph = await loadAffiliateRules({ client: ({ from: () => { const q: Record<string, unknown> = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: placeholderRows, error: null }) }; return q } }) as never, now: 7 })
  expect('the loader drops them too, so no disclosure is shown either', ph.length === 0 && linkPage({ bodyHtml: '<p>Place 0 and Place 1</p>', faqAnswers: [] }, ph, 'blog').count === 0)
  clearAffiliateRulesCache()

  // ---------- 5. loader: one joined query, ON only, 60 s cache, fail open ----------
  clearAffiliateRulesCache()
  let calls = 0
  const stub = (result: { data: unknown; error: { message: string } | null } | 'throw') => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        select: (cols: string) => ((q.cols = cols), q),
        eq: (c: string, v: string) => ((q.eq = [c, v]), q),
        order: () => q,
        limit: () => {
          calls++
          if (result === 'throw') throw new Error('boom')
          q.table = table
          return Promise.resolve(result)
        },
      }
      return q
    },
  })
  const goodRows = [{ id: 'k1', phrase: 'Croatia tours', scope: 'all', max_per_page: 2, affiliate_links: { slug: 'viator', status: 'active', url: 'https://merchant.shopco.com/a' } }]
  const t0 = 1_000_000
  const first = await loadAffiliateRules({ client: stub({ data: goodRows, error: null }) as never, now: t0 })
  const cached = await loadAffiliateRules({ client: stub({ data: [], error: null }) as never, now: t0 + RULES_TTL_MS - 1 })
  expect('the loader reads once and serves the rule from memory for 60 seconds', first.length === 1 && first[0].slug === 'viator' && first[0].max_per_page === 2 && cached.length === 1 && calls === 1)
  const refreshed = await loadAffiliateRules({ client: stub({ data: [], error: null }) as never, now: t0 + RULES_TTL_MS + 1 })
  expect('after 60 seconds it reads again', refreshed.length === 0 && calls === 2)
  clearAffiliateRulesCache()
  expect('a read error (or migration 0050 missing) fails open: no rules, no throw', (await loadAffiliateRules({ client: stub({ data: null, error: { message: 'relation "affiliate_keywords" does not exist' } }) as never, now: t0 })).length === 0)
  clearAffiliateRulesCache()
  expect('a thrown error fails open too', (await loadAffiliateRules({ client: stub('throw') as never, now: t0 })).length === 0)
  clearAffiliateRulesCache()
  const srcRules = read('lib/affiliate-rules.ts')
  const seen: string[] = []
  clearAffiliateRulesCache()
  await loadAffiliateRules({ client: ({ from: (t: string) => { const q: Record<string, unknown> = { select: (c: string) => (seen.push(t + ':' + c), q), eq: (c: string, v: string) => (seen.push(c + '=' + v), q), order: () => q, limit: () => Promise.resolve({ data: [], error: null }) }; return q } }) as never, now: 9 })
  clearAffiliateRulesCache()
  expect('the loader makes ONE query: ON keywords with the link (slug, status, address) joined', seen.length === 2 && seen[0] === 'affiliate_keywords:id, phrase, scope, max_per_page, link_id, affiliate_links!inner(slug, status, url)' && seen[1] === 'status=on', seen.join(' | '))

  // ---------- 6. hostile phrases and content ----------
  expect('phrase validation: 2 to 80 characters, trimmed, no angle brackets', cleanPhrase('  Croatia   tours ') === 'Croatia tours' && cleanPhrase('a') === null && cleanPhrase('x'.repeat(81)) === null && cleanPhrase('x'.repeat(80)) !== null && cleanPhrase('<b>hi</b>') === null && cleanPhrase('a\u0000b') === null && cleanPhrase(5) === null)
  expect('phrase problems come back in plain English', /too short/.test(phraseProblem('a') ?? '') && /too long/.test(phraseProblem('x'.repeat(90)) ?? '') && /< or >/.test(phraseProblem('a<b') ?? '') && phraseProblem('fine phrase') === null)
  const meta = ['a.b', '(x|y)', 'a+b', '[abc]', '^start', 'end$', 'q?', '\\d+', '.*', '{2}', 'a|b']
  expect('regex metacharacters in a phrase are matched literally', meta.every((p) => { const o = link(`<p>see ${p} here and axb</p>`, [rule(p)]); return o.count === 1 && strip(o.output) === `<p>see ${p} here and axb</p>` }), JSON.stringify(meta.filter((p) => link(`<p>see ${p} here and axb</p>`, [rule(p)]).count !== 1)))
  expect('"a.b" does not match "axb"; ".*" does not match everything', link('<p>axb</p>', [rule('a.b')]).count === 0 && link('<p>anything at all</p>', [rule('.*')]).count === 0)
  const xss = '"><img src=x onerror=alert(1)>'
  expect('a hostile phrase with angle brackets is rejected at validation and ignored by the linker', cleanPhrase(xss) === null && link(`<p>${xss}</p>`, [rule(xss)]).output === `<p>${xss}</p>`)
  const quote = link('<p>say "hello" onmouseover=x now</p>', [rule('onmouseover=x')])
  expect('a quote or equals sign in a phrase never reaches an attribute', quote.count === 1 && !/href="[^"]*onmouseover/.test(quote.output) && /href="\/go\/viator"/.test(quote.output))
  const hostileDoc = '<p>Croatia tours<script>alert(1)</script></p><p onclick="x()">Croatia tours</p><p><a href="javascript:alert(1)">Croatia tours</a></p>'
  const hd = link(hostileDoc, R)
  expect('hostile content: the script stays a script, the existing link is untouched, only safe text is linked', hd.output.includes('<script>alert(1)</script>') && hd.output.includes('<a href="javascript:alert(1)">Croatia tours</a>') && hd.count === 1)
  const textOut = link('<b>&</b> Croatia tours <i>', R, 'blog', { format: 'text' })
  expect('text format: everything is escaped, the link is built from the slug only', textOut.output === '&lt;b&gt;&amp;&lt;/b&gt; <a href="/go/viator" target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>Croatia tours</a> &lt;i&gt;')
  expect('text format with no rules still escapes (never raw HTML out of text in)', link('<img onerror=x>', [], 'blog', { format: 'text' }).output === '&lt;img onerror=x&gt;')
  const html = renderToStaticMarkup(React.createElement(AffiliateParts, { parts: linkTextParts('Win <b>Croatia tours</b> "now"', R, { context: 'blog' }).parts }))
  expect('React parts: the text is escaped by React and the link has the safe attributes', html.replace('data-affiliate-auto="true"', 'data-affiliate-auto') === 'Win &lt;b&gt;<a href="/go/viator" target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>Croatia tours</a>&lt;/b&gt; &quot;now&quot;', html)
  const big = '<p>' + 'Croatia tours '.repeat(100_000) + '</p>'
  const tBig = Date.now()
  const bigOut = link(big, R)
  expect('input over 300 KB is returned untouched, instantly', bigOut.output === big && bigOut.count === 0 && Date.now() - tBig < 2000)
  const nearBig = '<p>' + 'x '.repeat(100_000) + 'Croatia tours</p>'
  const t1 = Date.now()
  expect('a very long document is linked within a time limit', link(nearBig, R, 'blog', { budgetMs: 5000 }).count === 1 && Date.now() - t1 < 1500)
  expect('a document just over 300 KB is returned untouched', link('<p>' + 'Croatia tours '.repeat(23_000) + '</p>', R).count === 0 && link('<p>' + 'Croatia tours '.repeat(20_000) + '</p>', R).count === 1)
  // the QA case: many phrases made of repeated tokens against a long text
  const chain = Array.from({ length: 200 }, (_, i) => rule('a '.repeat(38) + 'b' + i, `aa-${i % 30}`))
  expect('phrases of repeated tokens are refused (never compiled)', compileRules(chain, 'blog').size === 0 && cleanPhrase('a b a b a b a b') === null && cleanPhrase('one two three four five six seven eight nine') === null && cleanPhrase('one two three four five six seven eight') !== null && cleanPhrase('big big big big cat') === null && cleanPhrase('big cat big dog') !== null)
  expect('the admin sees why: too many words, too repetitive', /too many words/.test(phraseProblem('one two three four five six seven eight nine') ?? '') && /repeats the same words/.test(phraseProblem('a a a a b') ?? ''))
  const tChain = Date.now()
  link('<p>' + 'a '.repeat(10_000) + '</p>', chain)
  expect('the QA pathological case (200 repeated-token phrases, 20 KB of text) is instant now', Date.now() - tChain < 1000, `${Date.now() - tChain} ms`)
  // legitimate but heavy: 200 long distinct phrases sharing a prefix, against 22 KB that matches the prefix everywhere
  const heavy = Array.from({ length: 200 }, (_, i) => rule(`the quick brown fox jumps over the lazy${i}`, `hv-${i % 30}`))
  const heavyText = '<p>' + 'the quick brown fox jumps over the lazy dog '.repeat(500) + '</p>'
  const tHeavy = Date.now()
  const heavyOut = link(heavyText, heavy)
  expect('a heavy page finishes fast with the default 50 ms budget and never throws', Date.now() - tHeavy < 2000 && heavyOut.output.length >= heavyText.length - 10, `${Date.now() - tHeavy} ms`)
  const spent = newLinkerState(-1)
  const noTime = link('<p>Croatia tours and Croatia tours</p>', R, 'blog', { state: spent })
  expect('when the time budget is gone, linking stops: the page comes back whole, unlinked, and the state says so', noTime.output === '<p>Croatia tours and Croatia tours</p>' && noTime.count === 0 && spent.truncated)
  const midState = newLinkerState(5000)
  const first2 = link('<p>Croatia tours</p>', R, 'blog', { state: midState })
  midState.budgetEnd = Date.now() - 1
  const second2 = link('<p>Croatia tours again</p>', [rule('again', 'ag')], 'blog', { state: midState })
  expect('links made before the budget ran out stay, later text is left alone', first2.count === 1 && second2.count === 0 && midState.truncated && midState.total === 1)
  // minor: self-closing non-void tags are open; raw-text elements are opaque
  expect('<h2/>, <a/> and <script/> open an element (a trailing slash means nothing in HTML)', none('<h2/>Croatia tours</h2>') && none('<a/>Croatia tours</a>') && none('<script/>Croatia tours</script>') && none('<h3 />Croatia tours</h3>'))
  expect('xmp, plaintext, noembed, noframes, textarea and title content is opaque', none('<xmp>Croatia tours</xmp>') && none('<noembed>Croatia tours</noembed>') && none('<noframes>Croatia tours</noframes>') && none('<title>Croatia tours</title>') && none('<p>a</p><plaintext>Croatia tours <p>more') && none('<textarea><b>Croatia tours</textarea>'))
  expect('text after an opaque element is linked again, and fake tags inside it do not confuse the scanner', link('<script>var a = "</b></a>"; if (1<2) {}</script><p>Croatia tours</p>', R).count === 1 && link('<xmp><a href="x"></xmp><p>Croatia tours</p>', R).count === 1 && link('<textarea></p></textarea><p>Croatia tours</p>', R).count === 1)
  expect('an opaque element that never closes leaves the rest untouched', none('<p>x</p><script>never closed Croatia tours'))
  // minor 7: the longest rule is used up, a shorter overlapping rule still gets its turn
  const overlap = link('<p>Paris hotels and Paris hotels, Paris</p>', [rule('Paris hotels', 'long'), rule('Paris', 'short')])
  expect('when the longest rule has used up its allowance a shorter overlapping rule takes over', anchors(overlap.output).join('|') === 'Paris hotels|Paris' && overlap.output.includes('/go/short') && overlap.output.includes('/go/long') && overlap.output.endsWith(', Paris</p>') && overlap.count === 2, overlap.output)
  const evil = '<a '.repeat(150_000)
  const t2 = Date.now()
  link(evil, R)
  expect('150,000 unclosed tag openers do not make the tag scanner quadratic', Date.now() - t2 < 3000, `${Date.now() - t2} ms`)
  const evil2 = '<p title="' + 'a'.repeat(500_000) + ' Croatia tours</p>'
  const t3 = Date.now()
  link(evil2, R)
  expect('an unterminated attribute quote scans in time', Date.now() - t3 < 3000, `${Date.now() - t3} ms`)
  const rules200 = Array.from({ length: 250 }, (_, i) => rule(`destination number ${i} guide`, `slug-${i % 40}`))
  expect('at most 200 rules are compiled', compileRules(rules200, 'blog').size === MAX_RULES)
  const doc200 = '<p>' + rules200.slice(0, 200).map((r) => `Visit ${r.phrase} today.`).join(' ') + '</p>'
  const t4 = Date.now()
  let linkedCount = 0
  for (let i = 0; i < 20; i++) linkedCount = link(doc200, rules200).count
  expect('200 rules on a long page: 20 renders under a time limit, capped at 6 links', linkedCount === 6 && Date.now() - t4 < 2000, `${Date.now() - t4} ms`)
  const hostileRules = Array.from({ length: 200 }, (_, i) => rule(`(a+)+${i}$`, 'vi'))
  const t5 = Date.now()
  link('<p>' + 'a'.repeat(50_000) + '</p>', hostileRules)
  expect('regex-looking phrases cannot cause catastrophic backtracking', Date.now() - t5 < 2000, `${Date.now() - t5} ms`)

  // ---------- 7. no mutation, markdown stays as stored ----------
  const rulesCopy = JSON.stringify(R)
  const input = '<p>Croatia tours</p>'
  const inputCopy = String(input)
  link(input, R)
  expect('the input string and the rule objects are not changed', input === inputCopy && JSON.stringify(R) === rulesCopy)
  const guide = { name: 'Croatia', body: 'Plan Croatia tours with us.\n\n## Croatia tours\n\nText [Croatia tours](/x).', faq: [{ q: 'Croatia tours?', a: 'Yes, Croatia tours run.' }], key_takeaways: [] }
  const bodyCopy = guide.body
  const linkedGuide = linkedGuideContent(guide, R, 'guides')
  expect('guide: the stored markdown is untouched; paragraph linked once, heading and existing link not', guide.body === bodyCopy && linkedGuide.count === 1 && anchors(linkedGuide.bodyHtml).length === 1 && linkedGuide.bodyHtml.includes('<h2>Croatia tours</h2>'))
  const guideHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(GuideArticle, { guide, html: linkedGuide.bodyHtml }), React.createElement(GuideFaqList, { guide, answers: linkedGuide.answers })))
  expect('guide components render the linked article and plain FAQ text', guideHtml.includes('data-affiliate-auto') && guideHtml.includes('Yes, Croatia tours run.'))
  expect('guide components without the new props render exactly as before (admin preview)', !renderToStaticMarkup(React.createElement(GuideArticle, { guide })).includes('data-affiliate-auto'))
  const md = link('Intro Croatia tours here.\n\n# Croatia tours\n\n`Croatia tours` and [Croatia tours](/x) and https://x.com/Croatia tours\n\n```\nCroatia tours\n```\n', R, 'blog', { format: 'markdown' })
  expect('markdown format: only the plain paragraph text becomes a markdown link to /go', md.count === 1 && md.output.startsWith('Intro [Croatia tours](/go/viator) here.') && md.output.includes('# Croatia tours\n') && md.output.includes('`Croatia tours`') && md.output.includes('\nCroatia tours\n```'))

  // ---------- 8. disclosure ----------
  const withLinks = renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 2, language: 'en' }))
  expect('the disclosure shows when at least one auto-link is on the page, with the default wording', withLinks.includes(DEFAULT_DISCLOSURE) && withLinks.includes('data-affiliate-disclosure'))
  expect('no disclosure when there are no auto-links', renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 0, language: 'en' })) === '')
  expect('the disclosure is translated (French and Spanish)', renderToStaticMarkup(React.createElement(AffiliateAutoDisclosure, { count: 1, language: 'fr' })).includes(translate('fr', DEFAULT_DISCLOSURE).replace(/'/g, '&#x27;')) && translate('fr', DEFAULT_DISCLOSURE) !== DEFAULT_DISCLOSURE && translate('es', DEFAULT_DISCLOSURE) !== DEFAULT_DISCLOSURE)
  for (const f of ['components/guide-page.tsx', 'app/destinations/[slug]/page.tsx', 'app/blog/[slug]/page.tsx']) {
    const src = read(f)
    expect(`${f} loads the rules with the page data, links the content and shows the disclosure`, /loadAffiliateRules\(\)/.test(src) && /AffiliateAutoDisclosure/.test(src) && (/linkedGuidePage|linkPageFields/.test(src)))
  }
  const blogSrc = read('app/blog/[slug]/page.tsx')
  expect('the blog links the rendered HTML only: the stored post body and the FAQ JSON-LD still use the raw post', /const linked = linkPageFields\(fieldSet\.fields, affiliateRules, "blog"\)/.test(blogSrc) && /name: f\.q, acceptedAnswer: \{ "@type": "Answer", text: f\.a \}/.test(blogSrc))

  // ---------- 9. rule validation + migration ----------
  const L = '11111111-1111-4111-8111-111111111111'
  const K = (o: Record<string, unknown>) => normalizeKeywordInput({ phrase: 'Croatia tours', link_id: L, ...o })
  expect('keyword input: a good rule is kept with scope all and max 1 by default', (() => { const r = K({}); return r.ok && r.value.scope === 'all' && r.value.max_per_page === 1 && r.value.phrase === 'Croatia tours' })())
  expect('keyword input: bad phrase, link, scope and max are refused', !K({ phrase: 'a' }).ok && !K({ phrase: '<x>' }).ok && !K({ link_id: 'nope' }).ok && !K({ link_id: '' }).ok && !K({ scope: 'everywhere' }).ok && !K({ max_per_page: 0 }).ok && !K({ max_per_page: 4 }).ok && !K({ max_per_page: 1.5 }).ok && K({ max_per_page: '3', scope: 'blog' }).ok)
  const mig = read('supabase/migrations/0050_affiliate_keywords.sql')
  expect('migration 0050: table, unique (lower(phrase), link_id), cascade, scope/status/max checks, RLS on with no policy', /create table if not exists affiliate_keywords/.test(mig) && /unique index if not exists[\s\S]*\(lower\(phrase\), link_id\)/.test(mig) && /on delete cascade/.test(mig) && /scope in \('all', 'guides', 'blog', 'destinations'\)/.test(mig) && /status in \('on', 'off'\)/.test(mig) && /between 1 and 3/.test(mig) && /enable row level security/.test(mig) && !/create policy/i.test(mig))
  expect('migration 0050 is additive and idempotent', !/drop |delete |truncate |alter column/i.test(mig.replace(/on delete cascade/g, '')) && !/--.*—/.test(mig))
  expect('missing-table detector matches only the keywords table errors', isMissingKeywordsTable('relation "public.affiliate_keywords" does not exist') && isMissingKeywordsTable("Could not find the table 'public.affiliate_keywords' in the schema cache") && !isMissingKeywordsTable('duplicate key value') && /migration 0050/.test(KEYWORDS_MIGRATION_MESSAGE))

  // ---------- 10. usage report (part 4) ----------
  const doc = (context: PageContext, path: string, markdown: string, faqAnswers: string[] = [], title = path): UsageDoc => ({ context, path, title, markdown, faqAnswers })
  const kws = [
    { id: 'k1', phrase: 'Croatia tours', scope: 'all' as const, status: 'on' as const },
    { id: 'k2', phrase: 'Temptations', scope: 'all' as const, status: 'off' as const },
    { id: 'k3', phrase: 'Split hotels', scope: 'blog' as const, status: 'on' as const },
  ]
  const docs: UsageDoc[] = [
    doc('destinations', '/destinations/croatia', 'Plan Croatia tours early. More Croatia tours later.\n\n## Croatia tours\n\nText.', ['Do Croatia tours run in winter?']),
    doc('blog', '/blog/a', 'We love [Croatia tours](/x) and Split hotels.'),
    doc('blog', '/blog/b', 'Croatia tours are great. Split hotels too.'),
    doc('guides', '/hotels/h', 'Split hotels are nice.'),
  ]
  const rep = buildUsageReport(docs, kws, { now: new Date('2026-10-18T00:00:00Z') })
  const u1 = rep.phrases.find((p) => p.keywordId === 'k1')!
  const u2 = rep.phrases.find((p) => p.keywordId === 'k2')!
  const u3 = rep.phrases.find((p) => p.keywordId === 'k3')!
  expect('usage: per phrase, pages and occurrences count plain text only (not headings, not inside links)', u1.pages === 2 && u1.occurrences === 4, JSON.stringify(u1))
  expect('usage: a phrase found nowhere is flagged not found', u2.notFound && u2.pages === 0 && u2.occurrences === 0 && !u1.notFound)
  expect('usage: scope is respected (a blog-only phrase is not counted on a guide)', u3.pages === 2 && u3.occurrences === 2, JSON.stringify(u3))
  expect('usage: examples carry the page, a title and a snippet with the match', u1.examples[0].path === '/destinations/croatia' && u1.examples[0].snippet.match.toLowerCase() === 'croatia tours' && u1.examples[0].snippet.before.includes('Plan'))
  const many2 = Array.from({ length: 15 }, (_, i) => doc('blog', `/blog/p${i}`, 'We sell Croatia tours.'))
  const rep15 = buildUsageReport(many2, kws)
  expect('usage: up to 10 example pages are listed, the page count is the true 15', rep15.phrases[0].examples.length === 10 && rep15.phrases[0].pages === 15)
  const trunc = buildUsageReport(many2, kws, { totalDocs: 700 })
  expect('usage: when the site has more than 500 documents the report says so', trunc.truncated && trunc.totalDocs === 700 && trunc.scanned === 15 && !rep15.truncated)
  const hugeKw = Array.from({ length: 200 }, (_, i) => ({ id: `k${i}`, phrase: `phrase number ${i}`, scope: 'all' as const, status: 'on' as const }))
  const hugeDocs = Array.from({ length: 400 }, (_, i) => doc('blog', `/blog/long-page-name-${i}`, hugeKw.map((k) => `${k.phrase} ${'filler words '.repeat(5)}`).join(' '), [], `A long title for page number ${i} of the site`))
  const bigRep = buildUsageReport(hugeDocs, hugeKw)
  const fitted = fitReport(bigRep)
  expect('usage: a big report is shrunk to fit 100 KB, counts kept', JSON.stringify(bigRep).length > 100_000 && JSON.stringify(fitted).length <= 100_000 && fitted.phrases[0].pages === 400)
  expect('usage: scan caps at 2000 documents in the loader constant (WP23, was 500)', MAX_USAGE_DOCS === 2000 && MAX_REPORT_BYTES === 100_000)

  // preview
  const pv = previewRule(docs, { phrase: 'Croatia tours', scope: 'all', max_per_page: 2 })
  expect('preview: lists the pages where it would link, with counts, willLink and a snippet to highlight', pv.pageCount === 2 && pv.pages[0].path === '/destinations/croatia' && pv.pages[0].count === 3 && pv.pages[0].willLink === 2 && pv.pages[0].snippet.match.length > 0)
  expect('preview: warns about a heading and about a phrase already inside another link', pv.pages[0].warnings.some((w) => /heading/.test(w)) && pv.warnings.some((w) => /heading/.test(w)) && pv.warnings.some((w) => /already inside another link/.test(w)))
  expect('preview: scope guides leaves blog pages out; scope blog leaves guides out', previewRule(docs, { phrase: 'Split hotels', scope: 'guides', max_per_page: 1 }).pageCount === 1 && previewRule(docs, { phrase: 'Split hotels', scope: 'blog', max_per_page: 1 }).pageCount === 2)
  expect('preview: not found anywhere is said plainly', previewRule(docs, { phrase: 'Temptations', scope: 'all', max_per_page: 1 }).explanation?.includes('was not found in any of them') === true)
  expect('preview: a very short phrase is flagged', previewRule(docs, { phrase: 'is', scope: 'all', max_per_page: 1 }).warnings.some((w) => /very short/.test(w)))
  const common = previewRule(Array.from({ length: 45 }, (_, i) => doc('blog', `/blog/c${i}`, 'We love the beach here.')), { phrase: 'beach', scope: 'all', max_per_page: 1 })
  expect('preview: found on more than 40 pages warns "this may look spammy"', common.pageCount === 45 && common.warnings.some((w) => /this may look spammy/.test(w)) && common.shown === PREVIEW_SHOWN)
  expect('preview: 40 pages or fewer does not warn', !previewRule(Array.from({ length: 40 }, (_, i) => doc('blog', `/blog/c${i}`, 'We love the beach here.')), { phrase: 'beach', scope: 'all', max_per_page: 1 }).warnings.some((w) => /spammy/.test(w)))
  expect('preview: a bad phrase gives a warning, not a crash', previewRule(docs, { phrase: '<b>', scope: 'all', max_per_page: 1 }).pageCount === 0)

  // reading the site and storing the report
  const siteDb: Db = {
    tables: {
      affiliate_keywords: [{ id: 'k1', phrase: 'Croatia tours', link_id: 'L1', scope: 'all', max_per_page: 1, status: 'on', created_at: '2026-01-01' }],
      guides: [
        { kind: 'destinations', slug: 'croatia', name: 'Croatia', body: 'Plan Croatia tours.', faq: [{ q: 'q', a: 'Croatia tours run daily.' }], status: 'published' },
        { kind: 'destinations', slug: 'draftland', name: 'Draftland', body: 'Croatia tours', faq: [], status: 'draft' },
        { kind: 'weird', slug: 'x', name: 'X', body: 'Croatia tours', faq: [], status: 'published' },
      ],
      posts: [
        { title: 'Live', slug: 'live', body: 'Croatia tours again.', faq: null, status: 'published', publish_date: '2026-01-01T00:00:00Z' },
        { title: 'Future', slug: 'future', body: 'Croatia tours', faq: null, status: 'published', publish_date: '2027-01-01T00:00:00Z' },
        { title: 'Draft', slug: 'dr', body: 'Croatia tours', faq: null, status: 'draft', publish_date: null },
      ],
    },
  }
  const scanned = await rescanSite(fakeAdmin(siteDb), new Date('2026-10-18T00:00:00Z'))
  const storedRaw = (siteDb.tables.app_settings ?? []).find((r) => r.key === USAGE_SETTING_KEY)?.value as string | undefined
  expect('rescan: reads published guides and live posts only, counts them, and stores a compact report in app_settings', scanned.ok && scanned.report.scanned === 2 + staticUsageDocs().length && scanned.report.phrases[0].pages === 2 && scanned.report.phrases[0].occurrences === 3 && !!storedRaw && storedRaw.length <= 100_000 && !/\n/.test(storedRaw), JSON.stringify(scanned))
  expect('rescan: the stored report can be read back', (await loadStoredReport(fakeAdmin(siteDb)))?.phrases[0].keywordId === 'k1' && (await loadStoredReport(fakeAdmin({ tables: {} }))) === null)
  const missing = await rescanSite({ from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'relation "affiliate_keywords" does not exist' } }) }) }) }) } as never)
  expect('rescan before migration 0050 says so and does not throw', !missing.ok && missing.migrationMissing === true)
  const emptyScan = await rescanSite(fakeAdmin({ tables: { affiliate_keywords: [], guides: [], posts: [] } }))
  expect('rescan with no rules and no content gives an empty report (only the fixed pages are counted)', emptyScan.ok && emptyScan.report.phrases.length === 0 && emptyScan.report.scanned === staticUsageDocs().length)

  // refresh after every change
  let revalidated = 0
  let rescans = 0
  const calls2: string[] = []
  clearAffiliateRulesCache()
  await loadAffiliateRules({ client: stub({ data: goodRows, error: null }) as never, now: 5 })
  const callsBefore = calls
  resetUsageDebounce()
  const rf = await refreshAfterChange(fakeAdmin({ tables: {} }), { revalidate: () => { revalidated++; calls2.push('pages') }, rescan: async () => { rescans++; calls2.push('usage'); return { ok: true } } })
  await loadAffiliateRules({ client: stub({ data: [], error: null }) as never, now: 6 })
  expect('a change clears the rules cache, refreshes cached pages, then recomputes the usage report', rf.rules && rf.pages && rf.usage && revalidated === 1 && rescans === 1 && calls2.join(',') === 'pages,usage' && calls === callsBefore + 1)
  const bad = await refreshAfterChange(fakeAdmin({ tables: {} }), { revalidate: () => { throw new Error('no next here') }, rescan: async () => { throw new Error('db down') } })
  expect('a failed refresh never throws; the result says what did not work', !bad.pages && !bad.usage && bad.rules)
  const defaultRefresh = await refreshAfterChange(fakeAdmin({ tables: { affiliate_keywords: [], guides: [], posts: [] } }))
  expect('the default refresh path does not throw outside Next either', typeof defaultRefresh.pages === 'boolean')
  clearAffiliateRulesCache()

  // admin routes
  const kwRoutes = ['app/api/admin/affiliate-keywords/route.ts', 'app/api/admin/affiliate-keywords/[id]/route.ts', 'app/api/admin/affiliate-keywords/preview/route.ts', 'app/api/admin/affiliate-keywords/rescan/route.ts']
  for (const f of kwRoutes) {
    const src = read(f)
    const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)\(request: Request[^)]*\) \{\r?\n  if \(!isAuthorized\(request\)\)/g)].length
    const declared = [...src.matchAll(/export async function (GET|POST|PATCH|DELETE)\(/g)].length
    expect(`${f}: every handler checks isAuthorized first`, handlers === declared && declared > 0)
  }
  // ---------- 11. keyword actions, behaviourally ----------
  const LA = '11111111-1111-4111-8111-111111111111'
  const LB = '22222222-2222-4222-8222-222222222222'
  const kwDb = (): Db => ({
    tables: {
      affiliate_links: [{ id: LA, slug: 'viator', title: 'Viator', merchant: 'Viator', status: 'active', url: 'https://viator.shopco.com/a' }, { id: LB, slug: 'gyg', title: 'GetYourGuide', merchant: null, status: 'active', url: 'https://gyg.shopco.com/a' }],
      affiliate_keywords: [],
      guides: [{ kind: 'destinations', slug: 'croatia', name: 'Croatia', body: 'Plan Croatia tours here. Croatia tours rock.', faq: [], status: 'published' }],
      posts: [],
    },
  })
  let kwRefresh = 0
  const kd = { revalidate: () => { kwRefresh++ }, rescan: async () => ({ ok: true }), now: () => 10_000_000 }
  resetUsageDebounce()
  const d0 = kwDb()
  const c1 = await createKeyword(fakeAdmin(d0), { phrase: 'Croatia tours', link_id: LA }, kd)
  expect('creating a phrase: 201, ON, refreshed, and the server itself reports where it would link', c1.status === 201 && (d0.tables.affiliate_keywords![0] as { status: string }).status === 'on' && kwRefresh === 1 && c1.body.pageCount === 1 && Array.isArray(c1.body.warnings))
  const c2 = await createKeyword(fakeAdmin(d0), { phrase: 'croatia TOURS', link_id: LB }, kd)
  expect('the same phrase on a DIFFERENT link is refused (409) and says which link owns it', c2.status === 409 && /Viator/.test(String(c2.body.error)) && d0.tables.affiliate_keywords!.length === 1)
  const c3 = await createKeyword(fakeAdmin(d0), { phrase: 'Croatia tours', link_id: LA }, kd)
  expect('the same phrase on the same link is refused too', c3.status === 409 && d0.tables.affiliate_keywords!.length === 1)
  const pv2 = await previewKeyword(fakeAdmin(d0), { phrase: 'Croatia tours', link_id: LB })
  expect('Preview warns that the phrase already goes to another link', pv2.status === 200 && (pv2.body.warnings as string[]).some((w) => /already goes to Viator/.test(w)) && !String((await previewKeyword(fakeAdmin(d0), { phrase: 'Croatia tours', link_id: LA })).body.warnings).includes('already goes'))
  expect('Preview reports the pages and the highlighted match', (pv2.body.pageCount as number) === 1)
  expect('server-side phrase checks: too many words, repeated tokens, missing link, bad scope', (await createKeyword(fakeAdmin(kwDb()), { phrase: 'one two three four five six seven eight nine', link_id: LA }, kd)).status === 400 && (await createKeyword(fakeAdmin(kwDb()), { phrase: 'a a a a b', link_id: LA }, kd)).status === 400 && (await createKeyword(fakeAdmin(kwDb()), { phrase: 'Fine phrase', link_id: '33333333-3333-4333-8333-333333333333' }, kd)).status === 400 && (await createKeyword(fakeAdmin(kwDb()), { phrase: 'Fine phrase', link_id: LA, scope: 'x' }, kd)).status === 400)
  const kid = (d0.tables.affiliate_keywords![0] as { id: string }).id
  const ku1 = await updateKeyword(fakeAdmin(d0), kid, { link_id: '44444444-4444-4444-8444-444444444444' }, kd)
  expect('moving a phrase to a link that does not exist is a 400, not a 500', ku1.status === 400 && /no longer exists/.test(String(ku1.body.error)) && (d0.tables.affiliate_keywords![0] as { link_id: string }).link_id === LA)
  const ku2 = await updateKeyword(fakeAdmin(d0), kid, { link_id: LB }, kd)
  expect('moving a phrase to a real link works', ku2.status === 200 && (d0.tables.affiliate_keywords![0] as { link_id: string }).link_id === LB)
  await createKeyword(fakeAdmin(d0), { phrase: 'Split hotels', link_id: LA }, kd)
  const splitId = (d0.tables.affiliate_keywords![1] as { id: string }).id
  const ku3 = await updateKeyword(fakeAdmin(d0), splitId, { phrase: 'Croatia tours' }, kd)
  expect('renaming a phrase onto one that another link owns is a 409', ku3.status === 409)
  expect('turning a phrase OFF and ON, and deleting it, each refresh the site', (await updateKeyword(fakeAdmin(d0), kid, { status: 'off' }, kd)).status === 200 && (d0.tables.affiliate_keywords![0] as { status: string }).status === 'off' && (await deleteKeyword(fakeAdmin(d0), kid, kd)).status === 200 && d0.tables.affiliate_keywords!.length === 1)
  expect('a body that is not an object is a 400 for create, update and preview', (await createKeyword(fakeAdmin(d0), null)).status === 400 && (await updateKeyword(fakeAdmin(d0), kid, null)).status === 400 && (await previewKeyword(fakeAdmin(d0), null)).status === 400)
  expect('an unknown phrase is a 404; nothing to change is a 400', (await updateKeyword(fakeAdmin(d0), 'nope', { status: 'on' }, kd)).status === 404 && (await updateKeyword(fakeAdmin(d0), splitId, {}, kd)).status === 400)
  const noTable = { from: (t: string) => { const q: Record<string, unknown> = { select: () => q, order: () => q, eq: () => q, limit: () => Promise.resolve({ data: null, error: { message: `relation "${t}" does not exist` } }), delete: () => q, then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: 'relation "affiliate_keywords" does not exist' } }) }; return q } } as never
  expect('before migration 0050 every write answers 409 "Run migration 0050 first" and the list says not migrated', (await createKeyword(noTable, { phrase: 'Croatia tours', link_id: LA }, kd)).status === 409 && (await updateKeyword(noTable, kid, { status: 'on' }, kd)).status === 409 && (await deleteKeyword(noTable, kid, kd)).status === 409 && (await listKeywords(noTable)).body.migrated === false)
  expect('phraseConflict ignores the rule being edited and the same link', phraseConflict([{ id: 'a', phrase: 'X y', link_id: LA }], 'x  Y', LA) === null && phraseConflict([{ id: 'a', phrase: 'X y', link_id: LA }], 'x y', LB)?.id === 'a' && phraseConflict([{ id: 'a', phrase: 'X y', link_id: LA }], 'x y', LB, 'a') === null)

  // ---------- 12. the usage scan after changes happens at most once a minute ----------
  resetUsageDebounce()
  let clock = 50_000_000
  let scans2 = 0
  const timers: (() => void)[] = []
  const deb = { revalidate: () => {}, rescan: async () => { scans2++; return { ok: true } }, now: () => clock, schedule: (run: () => void) => { timers.push(run) } }
  const adm = fakeAdmin({ tables: {} })
  const g1 = await refreshAfterChange(adm, deb)
  clock += 5_000
  const g2 = await refreshAfterChange(adm, deb)
  clock += 5_000
  const g3 = await refreshAfterChange(adm, deb)
  expect('the first change scans at once; changes inside the next minute only raise a pending flag (one timer, no extra scans)', g1.usage && !g1.deferred && !g2.usage && g2.deferred && g3.deferred && scans2 === 1 && usageRefreshPending() && timers.length === 1)
  expect('pages and rules are still refreshed on every change, even when the scan is put off', g2.pages && g3.pages && g2.rules)
  expect('the pending flag does nothing before the minute is over', (await flushPendingUsage(adm, deb)) === false && scans2 === 1)
  clock += USAGE_MIN_GAP_MS
  timers[0]()
  await new Promise((r) => setTimeout(r, 10))
  expect('after the minute ONE deferred scan runs and clears the flag', scans2 === 2 && !usageRefreshPending())
  const g4 = await refreshAfterChange(adm, deb)
  expect('and a change right after it is put off again', g4.deferred && scans2 === 2)
  clock += USAGE_MIN_GAP_MS
  expect('opening the admin list flushes a pending scan once the minute is over', (await listKeywords(fakeAdmin({ tables: { affiliate_keywords: [] } }), deb)).status === 200 && scans2 === 3 && !usageRefreshPending())
  resetUsageDebounce()

  const { POST: kwPost } = await import('../app/api/admin/affiliate-keywords/route')
  const { GET: kwGet } = await import('../app/api/admin/affiliate-keywords/route')
  const { PATCH: kwPatch, DELETE: kwDelete } = await import('../app/api/admin/affiliate-keywords/[id]/route')
  const { POST: kwPreview } = await import('../app/api/admin/affiliate-keywords/preview/route')
  const { POST: kwRescan } = await import('../app/api/admin/affiliate-keywords/rescan/route')
  const anon = () => new Request('http://localhost/api/admin/affiliate-keywords', { method: 'POST', body: '{}' })
  const statuses = await Promise.all([kwGet(anon()), kwPost(anon()), kwPatch(anon(), { params: { id: 'x' } }), kwDelete(anon(), { params: { id: 'x' } }), kwPreview(anon()), kwRescan(anon())].map((p) => p.then((r) => r.status)))
  expect('without an admin token every keyword route answers 401', statuses.every((s) => s === 401), statuses.join(','))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
