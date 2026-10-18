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
    { id: 'k1', phrase: 'Croatia tours', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'viator', status: 'active' } },
    { id: 'k2', phrase: 'Temptations', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'temptations', status: 'hidden' } },
    { id: 'k3', phrase: 'Drafty', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'drafty', status: 'draft' } },
    { id: 'k4', phrase: 'Lonely', scope: 'all', max_per_page: 1, affiliate_links: null },
    { id: 'k5', phrase: 'Arr', scope: 'all', max_per_page: 1, affiliate_links: [{ slug: 'arr-link', status: 'active' }] },
  ]
  expect('a keyword whose link is OFF (hidden or draft) or missing produces no rule', rowsToRules(joined).map((r) => r.phrase).join(',') === 'Croatia tours,Arr')
  expect('turning a link OFF removes its phrase links on the next render', (() => {
    const html = '<p>Visit Temptations and Croatia tours.</p>'
    const before = link(html, rowsToRules(joined.map((j) => (j.id === 'k2' ? { ...j, affiliate_links: { slug: 'temptations', status: 'active' } } : j))))
    const after = link(html, rowsToRules(joined))
    return before.output.includes('/go/temptations') && !after.output.includes('/go/temptations') && after.output.includes('/go/viator')
  })())
  expect('editing a link URL does not change the rendered href (it is /go/<slug>)', (() => {
    const rows = (url: string) => rowsToRules([{ id: 'k', phrase: 'Croatia tours', scope: 'all', max_per_page: 1, affiliate_links: { slug: 'viator', status: 'active', url } as never }])
    return link('<p>Croatia tours</p>', rows('https://old.example.com/a')).output === link('<p>Croatia tours</p>', rows('https://new.example.com/b')).output
  })())

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
  const goodRows = [{ id: 'k1', phrase: 'Croatia tours', scope: 'all', max_per_page: 2, affiliate_links: { slug: 'viator', status: 'active' } }]
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
  expect('the loader asks only for ON keywords and joins the link in the same query', /affiliate_links!inner\(slug, status\)/.test(srcRules) && /\.eq\('status', 'on'\)/.test(srcRules))

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
  expect('input over 1 MB is returned untouched, instantly', bigOut.output === big && bigOut.count === 0 && Date.now() - tBig < 500)
  const nearBig = '<p>' + 'x '.repeat(200_000) + 'Croatia tours</p>'
  const t1 = Date.now()
  expect('a very long document is linked within a time limit', link(nearBig, R).count === 1 && Date.now() - t1 < 1500)
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
    expect(`${f} loads the rules with the page data, links the content and shows the disclosure`, /loadAffiliateRules\(\)/.test(src) && /AffiliateAutoDisclosure/.test(src) && (/linkedGuideContent|linkPage/.test(src)))
  }
  const blogSrc = read('app/blog/[slug]/page.tsx')
  expect('the blog links the rendered HTML only: the stored post body and the FAQ JSON-LD still use the raw post', /const linked = linkPage\(\{ bodyHtml, faqAnswers/.test(blogSrc) && /name: f\.q, acceptedAnswer: \{ "@type": "Answer", text: f\.a \}/.test(blogSrc))

  // ---------- 9. rule validation + migration ----------
  const L = '11111111-1111-4111-8111-111111111111'
  const K = (o: Record<string, unknown>) => normalizeKeywordInput({ phrase: 'Croatia tours', link_id: L, ...o })
  expect('keyword input: a good rule is kept with scope all and max 1 by default', (() => { const r = K({}); return r.ok && r.value.scope === 'all' && r.value.max_per_page === 1 && r.value.phrase === 'Croatia tours' })())
  expect('keyword input: bad phrase, link, scope and max are refused', !K({ phrase: 'a' }).ok && !K({ phrase: '<x>' }).ok && !K({ link_id: 'nope' }).ok && !K({ link_id: '' }).ok && !K({ scope: 'everywhere' }).ok && !K({ max_per_page: 0 }).ok && !K({ max_per_page: 4 }).ok && !K({ max_per_page: 1.5 }).ok && K({ max_per_page: '3', scope: 'blog' }).ok)
  const mig = read('supabase/migrations/0050_affiliate_keywords.sql')
  expect('migration 0050: table, unique (lower(phrase), link_id), cascade, scope/status/max checks, RLS on with no policy', /create table if not exists affiliate_keywords/.test(mig) && /unique index if not exists[\s\S]*\(lower\(phrase\), link_id\)/.test(mig) && /on delete cascade/.test(mig) && /scope in \('all', 'guides', 'blog', 'destinations'\)/.test(mig) && /status in \('on', 'off'\)/.test(mig) && /between 1 and 3/.test(mig) && /enable row level security/.test(mig) && !/create policy/i.test(mig))
  expect('migration 0050 is additive and idempotent', !/drop |delete |truncate |alter column/i.test(mig.replace(/on delete cascade/g, '')) && !/--.*—/.test(mig))
  expect('missing-table detector matches only the keywords table errors', isMissingKeywordsTable('relation "public.affiliate_keywords" does not exist') && isMissingKeywordsTable("Could not find the table 'public.affiliate_keywords' in the schema cache") && !isMissingKeywordsTable('duplicate key value') && /migration 0050/.test(KEYWORDS_MIGRATION_MESSAGE))

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}
void main()
