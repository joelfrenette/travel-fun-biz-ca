// Offline self-check for hub WP6: table of contents (threshold, ids, accessibility markup), breadcrumbs (visible trail and
// BreadcrumbList agree), the home WebSite node and the /from/* share picture, read from the page source.
// Run: pnpm dlx tsx scripts/check-toc-breadcrumbs.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addHeadingIds, buildToc, plainText, slugifyHeading, TOC_MIN_H2 } from '../lib/toc'
import { buildBreadcrumbJsonLd } from '../lib/jsonld'
import { buildWebSiteJsonLd } from '../lib/org-jsonld'
import { renderMarkdown } from '../lib/markdown'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ---- toc ----
check('threshold is four', TOC_MIN_H2 === 4)
const h = (n: number) => Array.from({ length: n }, (_, i) => `<h2>Section ${String.fromCharCode(65 + i)}</h2><p>text</p>`).join('\n')
const three = buildToc(h(3))
check('three h2s: no list and the html is returned unchanged', three.items.length === 0 && three.html === h(3))
const four = buildToc(h(4))
check('four h2s: a list of four', four.items.length === 4, four.items)
check('four h2s: every heading got an id that the list points at', four.items.every((it) => four.html.includes(`<h2 id="${it.id}">`)), four)
check('ids are unique', new Set(four.items.map((i) => i.id)).size === 4)
const dup = addHeadingIds('<h2>Same</h2><h2>Same</h2><h2>Same!</h2>')
check('duplicate headings get distinct ids', new Set(dup.items.map((i) => i.id)).size === 3, dup.items)
check('ids are prefixed so they cannot collide with page ids', dup.items.every((i) => i.id.startsWith('sec-')))
check('heading with an id keeps it', addHeadingIds('<h2 id="mine">Hi there</h2>').items[0].id === 'mine')
check('h3 and h1 are left alone', addHeadingIds('<h1>T</h1><h3>Sub</h3>').items.length === 0)
check('heading text strips tags and decodes entities', plainText('Fish &amp; <em>chips</em>  now') === 'Fish & chips now')
check('slug is lower-case ascii with hyphens', slugifyHeading('Why go to Zürich?') === 'why-go-to-zurich')
check('empty heading text still gets a usable id', addHeadingIds('<h2><img src="x"></h2>').html.includes('id="sec-section"'))
const withFaq = buildToc(h(4), { extra: [{ id: 'faq-heading', text: 'Frequently asked questions' }] })
check('extra FAQ entry is appended', withFaq.items.length === 5 && withFaq.items[4].id === 'faq-heading')
check('the FAQ alone does not reach the threshold', buildToc(h(3), { extra: [{ id: 'faq-heading', text: 'FAQ' }] }).items.length === 0)
const md = buildToc(renderMarkdown('Intro.\n\n## One\n\na\n\n## Two\n\nb\n\n### Sub\n\n## Three\n\nc\n\n## Four\n\nd'))
check('works on rendered markdown', md.items.length === 4 && md.html.includes('<h3>Sub</h3>'), md.items)
const comp = read('components/table-of-contents.tsx')
check('component: a labelled nav, plain links, no script', /<nav aria-labelledby="toc-title"/.test(comp) && /href=\{`#\$\{it\.id\}`\}/.test(comp) && !/use client|useEffect|useState/.test(comp))
check('component: renders nothing for an empty list', /items\.length === 0\) return null/.test(comp))
check('css: jump targets clear the sticky header', /\.markdown-body h2\[id\]\s*\{\s*scroll-margin-top/.test(read('app/globals.css')))
check('blog page uses the contents list', /buildToc\(/.test(read('app/blog/[slug]/page.tsx')) && /<TableOfContents/.test(read('app/blog/[slug]/page.tsx')))
check('guide page uses the contents list', /buildToc\(/.test(read('components/guide-page.tsx')) && /<TableOfContents/.test(read('components/guide-page.tsx')))

// ---- breadcrumbs ----
const crumbs = read('components/breadcrumbs.tsx')
check('breadcrumbs: emits BreadcrumbList next to the visible trail', /buildBreadcrumbJsonLd/.test(crumbs) && /aria-label="Breadcrumb"/.test(crumbs) && /aria-current="page"/.test(crumbs))
check('breadcrumbs: needs two or more crumbs (Google ignores a one-item list)', /crumbs\.length < 2\) return null/.test(crumbs))
const ld = buildBreadcrumbJsonLd([{ name: 'Home', url: 'https://x.test/' }, { name: 'Trips', url: 'https://x.test/packages' }, { name: 'A trip', url: 'https://x.test/packages/a' }])
check('BreadcrumbList positions run 1..n', ld.itemListElement.map((i) => i.position).join() === '1,2,3')
const trip = read('app/packages/[slug]/page.tsx')
check('trip page: visible breadcrumbs for every trip', /<Breadcrumbs crumbs=/.test(trip) && /currentPath=\{`\/packages\/\$\{pkg\.slug\}`\}/.test(trip))
check('trip page: no second BreadcrumbList for past trips', !/buildBreadcrumbJsonLd/.test(trip))
check('who-we-are: visible breadcrumbs', /<Breadcrumbs crumbs=\{\[\{ name: "Home", path: "\/" \}, \{ name: "Who We Are" \}\]\} currentPath="\/who-we-are"/.test(read('app/who-we-are/page.tsx')))

// ---- home WebSite ----
const ws = buildWebSiteJsonLd()
check('WebSite node: type, name, url, publisher', ws['@type'] === 'WebSite' && !!ws.name && /^https:\/\//.test(ws.url) && ws.publisher.name === ws.name && /^https:\/\//.test(ws.publisher.url))
check('WebSite node: no SearchAction (the site has no search)', !JSON.stringify(ws).includes('SearchAction'))
check('home page writes the WebSite node', /webSiteJsonLd/.test(read('app/page.tsx')) && /buildWebSiteJsonLd/.test(read('app/page.tsx')))

// ---- /from/* share picture ----
const from = read('app/from/[city]/page.tsx')
check('from page: openGraph.images set from an existing card or the default', /images: \[image\]/.test(from) && /ogImageEntry\("packages"/.test(from) && /DEFAULT_OG_IMAGE/.test(from))
check('from page: twitter large image', /summary_large_image/.test(from) && /images: \[image\.url\]/.test(from))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
