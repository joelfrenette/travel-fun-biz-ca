// Cache loop guard. Offline: pure decision table + source scans (+ the .next build output when it exists).
//
//   pnpm dlx tsx scripts/check-cache-loop.ts
//
// What it proves (see docs/factory/CACHE-LOOP.md):
//  1. The middleware decision table (cookie combinations x paths x kill switch) is exactly as designed.
//  2. Every public page under app/ has a cacheable mirror in app/x-cache/ or an explicit, reasoned exclusion.
//  3. Each mirror re-exports the SAME page and metadata (no copied page code) and declares a literal revalidate.
//  4. Nothing in the cacheable tree reads cookies() / headers() / searchParams, and the root layout does not either.
//  5. The mirror folder never leaks into canonical URLs, the sitemap, robots, llms files or navigation.
//  6. The kill switch turns everything off.
//  7. (If .next exists) the mirror routes were built as static / ISR pages, not as server-rendered ones.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  EXCLUDED_ROUTES,
  MIRRORED_ROUTES,
  MIRROR_PREFIX,
  decideRoute,
  isCachingEnabled,
  type DecisionInput,
} from '../lib/cache-routing'

const ROOT = process.cwd()
const failures: string[] = []
let passed = 0
function check(ok: boolean, message: string) {
  if (ok) passed++
  else failures.push(message)
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const norm = (p: string) => p.replace(/\\/g, '/')

// ---------- 1. Decision table ----------
const base: DecisionInput = { enabled: true, method: 'GET', pathname: '/', langCookie: undefined, currencyCookie: undefined, defaultCurrency: 'cad' }
const at = (over: Partial<DecisionInput>) => decideRoute({ ...base, ...over })

const samplePaths: Record<string, string> = {
  '/': '/x-cache',
  '/blog': '/x-cache/blog',
  '/blog/rhine-vs-croatia': '/x-cache/blog/rhine-vs-croatia',
  '/compare/rhine-vs-danube': '/x-cache/compare/rhine-vs-danube',
  '/best-time-to-visit/tahiti': '/x-cache/best-time-to-visit/tahiti',
  '/from/toronto': '/x-cache/from/toronto',
  '/packages': '/x-cache/packages',
  '/packages/australia-new-zealand': '/x-cache/packages/australia-new-zealand',
  '/who-we-are': '/x-cache/who-we-are',
  '/destinations': '/x-cache/destinations',
  '/destinations/tahiti': '/x-cache/destinations/tahiti',
  '/cruise-lines': '/x-cache/cruise-lines',
  '/cruise-lines/viking': '/x-cache/cruise-lines/viking',
  '/hotels': '/x-cache/hotels',
  '/hotels/some-hotel': '/x-cache/hotels/some-hotel',
  '/resorts': '/x-cache/resorts',
  '/resorts/some-resort': '/x-cache/resorts/some-resort',
  '/river-cruises': '/x-cache/river-cruises',
  '/river-cruises/rhine': '/x-cache/river-cruises/rhine',
  '/ships': '/x-cache/ships',
  '/ships/viking-longship': '/x-cache/ships/viking-longship',
  '/yachts': '/x-cache/yachts',
  '/yachts/some-yacht': '/x-cache/yachts/some-yacht',
  '/blog/': '/x-cache/blog', // trailing slash
}
for (const [path, mirror] of Object.entries(samplePaths)) {
  // No cookies: rewritten.
  const d = at({ pathname: path })
  check(d.action === 'rewrite' && d.to === mirror, `no cookies ${path} should rewrite to ${mirror}, got ${JSON.stringify(d)}`)
  // Default-valued cookies (a visitor who picked English / CAD) behave like no cookie.
  for (const [lang, cur] of [['en', undefined], [undefined, 'cad'], [undefined, 'CAD'], ['en', 'cad']] as const) {
    const e = at({ pathname: path, langCookie: lang, currencyCookie: cur })
    check(e.action === 'rewrite', `default-valued cookies (${lang},${cur}) on ${path} should still be cacheable`)
  }
  // Any real choice: passes through to the cookie-reading page.
  for (const [lang, cur] of [['fr', undefined], ['es', undefined], [undefined, 'usd'], [undefined, 'aud'], [undefined, 'eur'], ['fr', 'usd'], ['es', 'eur'], ['en', 'usd'], ['fr', 'cad'], ['xx', undefined], [undefined, 'zzz']] as const) {
    const e = at({ pathname: path, langCookie: lang, currencyCookie: cur })
    check(e.action === 'pass', `cookies (${lang},${cur}) on ${path} must reach the cookie page, got ${JSON.stringify(e)}`)
  }
  // Kill switch, non-GET, preview.
  check(at({ pathname: path, enabled: false }).action === 'pass', `kill switch off: ${path} must pass through`)
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) check(at({ pathname: path, method: m }).action === 'pass', `${m} ${path} must pass through`)
  check(at({ pathname: path, method: 'HEAD' }).action === 'rewrite', `HEAD ${path} should be cached like GET`)
  check(at({ pathname: path, previewCookie: true }).action === 'pass', `preview cookie on ${path} must pass through`)
  // The mirror address itself is never served directly.
  const m = decideRoute({ ...base, pathname: mirror })
  check(m.action === 'redirect' && m.to === (path === '/' ? '/' : path.replace(/\/$/, '')), `direct visit to ${mirror} should redirect to the real address, got ${JSON.stringify(m)}`)
  // ...even with the switch off.
  check(decideRoute({ ...base, pathname: mirror, enabled: false }).action === 'redirect', `${mirror} must redirect even when the kill switch is off`)
}
// Currency default follows the site (the .com replica is USD).
check(at({ pathname: '/', defaultCurrency: 'usd', currencyCookie: 'usd' }).action === 'rewrite', 'usd site: a usd cookie is the default')
check(at({ pathname: '/', defaultCurrency: 'usd', currencyCookie: 'cad' }).action === 'pass', 'usd site: a cad cookie is a choice')
// Paths that must never be rewritten.
for (const p of ['/admin', '/admin/blog', '/api/preferences', '/api/submit-lead', '/links', '/thank-you', '/submit-trip/abc', '/recap/abc', '/sitemap.xml', '/robots.txt', '/llms.txt', '/blog/rss.xml', '/og/news/x.png', '/go/abc', '/carousel/a/1', '/social-cover/a/b', '/_next/static/x.js', '/blog/a/b', '/from', '/compare', '/best-time-to-visit', '/packages/a/b', '/random-page']) {
  check(at({ pathname: p }).action === 'pass', `${p} must never be rewritten`)
}
// Kill switch parsing.
check(isCachingEnabled(undefined), 'kill switch: unset means ON')
check(isCachingEnabled(''), 'kill switch: empty means ON')
check(isCachingEnabled('on'), 'kill switch: on means ON')
for (const v of ['off', 'OFF', 'false', '0', 'no', ' off ']) check(!isCachingEnabled(v), `kill switch: "${v}" must turn it OFF`)

// ---------- 2. Every public page has a mirror or an exclusion ----------
const appFiles = walk(join(ROOT, 'app')).map((f) => norm(relative(join(ROOT, 'app'), f)))
const pageFolders = appFiles
  .filter((f) => f.endsWith('/page.tsx') || f === 'page.tsx')
  .map((f) => f.replace(/\/?page\.tsx$/, ''))
  .filter((f) => !f.startsWith('admin') && !f.startsWith('api') && !f.startsWith('x-cache'))
const mirrored = new Set(MIRRORED_ROUTES.map((r) => r.folder))
const excluded = new Set(EXCLUDED_ROUTES.map((r) => r.folder))
for (const folder of pageFolders) {
  check(mirrored.has(folder) || excluded.has(folder), `public page app/${folder}/page.tsx has neither a mirror in app/x-cache nor an exclusion in lib/cache-routing.ts`)
}
for (const r of MIRRORED_ROUTES) check(pageFolders.includes(r.folder), `MIRRORED_ROUTES lists "${r.folder}" but app/${r.folder}/page.tsx does not exist`)
for (const r of EXCLUDED_ROUTES) check(pageFolders.includes(r.folder) && r.reason.length > 10, `EXCLUDED_ROUTES "${r.folder}" must exist and give a reason`)
check(!MIRRORED_ROUTES.some((r) => excluded.has(r.folder)), 'a route cannot be both mirrored and excluded')

// ---------- 3. Mirror stubs: same page, same metadata, literal revalidate ----------
for (const r of MIRRORED_ROUTES) {
  const stubRel = r.folder ? `app/x-cache/${r.folder}/page.tsx` : 'app/x-cache/page.tsx'
  const origRel = r.folder ? `app/${r.folder}/page.tsx` : 'app/page.tsx'
  check(existsSync(join(ROOT, stubRel)), `missing mirror ${stubRel}`)
  if (!existsSync(join(ROOT, stubRel))) continue
  const stub = read(stubRel)
  const orig = read(origRel)
  const importPath = r.folder ? `@/app/${r.folder}/page` : '@/app/page'
  check(stub.includes(`import Page from '${importPath}'`), `${stubRel}: must import the real page default from ${importPath}`)
  check(/runStatic\(\(\) => Page\(/.test(stub), `${stubRel}: must render the real page inside runStatic()`)
  // metadata: same name as the original exports, re-exported from the original.
  const origMeta = /export const metadata\b/.test(orig) ? 'metadata' : /export (async )?function generateMetadata\b/.test(orig) ? 'generateMetadata' : null
  check(origMeta !== null, `${origRel}: no metadata export found (every public page needs one)`)
  if (origMeta) check(stub.includes(`export { ${origMeta} } from '${importPath}'`), `${stubRel}: must re-export ${origMeta} from the real page`)
  // revalidate literal; equal to the original when the original has one.
  const sr = /^export const revalidate = (\d+)$/m.exec(stub)
  check(!!sr, `${stubRel}: needs a literal "export const revalidate = N" (Next reads it statically)`)
  const or = /^export const revalidate = (\d+)/m.exec(orig)
  if (sr && or) check(sr[1] === or[1], `${stubRel}: revalidate ${sr[1]} differs from the real page's ${or[1]}`)
  if (sr) check(Number(sr[1]) > 0 && Number(sr[1]) <= 600, `${stubRel}: revalidate must be between 1 and 600 seconds`)
  // from/[city]: params are a closed set.
  if (/export const dynamicParams = false/.test(orig)) {
    check(/export const dynamicParams = false/.test(stub) && stub.includes(`export { generateStaticParams } from '${importPath}'`), `${stubRel}: must copy dynamicParams = false and re-export generateStaticParams`)
  } else if (r.folder.includes('[')) {
    check(/export function generateStaticParams\(\) \{\s*return \[\]\s*\}/.test(stub), `${stubRel}: dynamic route needs generateStaticParams() returning [] (on-demand ISR)`)
  }
  // Stubs are tiny: no page code copied.
  check(stub.split('\n').length <= 30, `${stubRel}: a mirror must stay a small re-export stub (found ${stub.split('\n').length} lines)`)
}
// No stray stubs.
const stubFiles = appFiles.filter((f) => f.startsWith('x-cache/') || f === 'x-cache')
check(stubFiles.length === MIRRORED_ROUTES.length && stubFiles.every((f) => f.endsWith('/page.tsx')), `app/x-cache must contain exactly ${MIRRORED_ROUTES.length} page.tsx stubs and nothing else (found ${stubFiles.length})`)

// ---------- 4. The cacheable tree reads no cookies / headers / searchParams ----------
const forbidden = /\b(cookies|headers|draftMode)\s*\(|from ['"]next\/headers['"]|searchParams|useSearchParams|unstable_noStore|noStore\(|force-dynamic|cache:\s*['"]no-store['"]/
for (const f of stubFiles) check(!forbidden.test(read(`app/${f}`)), `app/${f}: the cacheable tree must not read cookies, headers or searchParams`)
const layout = read('app/layout.tsx')
check(!forbidden.test(layout.replace(/\/\/.*$/gm, '')), 'app/layout.tsx must not read cookies / headers (it wraps every page)')
check(/<html lang="en"/.test(layout), 'app/layout.tsx: <html lang="en"> is the fixed default; LocaleEffects corrects it for fr / es')
// The real pages (and what they render) must not read cookies directly; only lib/preferences.ts may, behind isStaticRender().
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const prefs = code('lib/preferences.ts')
check(/if \(isStaticRender\(\)\) return/.test(prefs) && prefs.indexOf('isStaticRender()') < prefs.indexOf('cookies()'), 'lib/preferences.ts: getVisitorPreferences must return defaults inside runStatic() BEFORE it calls cookies()')
for (const f of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'components')))) {
  const rel = norm(relative(ROOT, f))
  if (rel.startsWith('app/admin') || rel.startsWith('app/api') || !/\.(tsx?|ts)$/.test(rel)) continue
  const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (/\bcookies\s*\(|from ['"]next\/headers['"]/.test(src)) check(false, `${rel}: public code must read the visitor's choice only through getVisitorPreferences() (lib/preferences.ts)`)
}
const sb = read('lib/supabase-admin.ts')
check(/isStaticRender\(\)\s*\?\s*fetch\(input, \{ \.\.\.init, next: \{ revalidate: 300 \} \}\)\s*:\s*fetch\(input, \{ \.\.\.init, cache: 'no-store' \}\)/.test(sb), "lib/supabase-admin.ts: reads are live ('no-store') everywhere except inside runStatic(), where they cache for 300 s")

// ---------- 5. The mirror folder never leaks ----------
const leakFiles = ['app/sitemap.ts', 'app/robots.ts', 'app/llms.txt/route.ts', 'app/llms-full.txt/route.ts', 'app/blog/rss.xml/route.ts', 'lib/site.ts', 'lib/jsonld.ts', 'content/navigation.ts', 'content/footer.ts', 'components/header.tsx', 'components/footer.tsx', 'lib/org-jsonld.ts']
for (const f of leakFiles) if (existsSync(join(ROOT, f))) check(!read(f).includes('x-cache'), `${f}: must never mention the mirror folder`)
// No mirrored page or lib file builds URLs from the mirror prefix (only middleware, routing and the stubs know it).
for (const f of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'lib')), walk(join(ROOT, 'components')), walk(join(ROOT, 'content')))) {
  const rel = norm(relative(ROOT, f))
  if (rel.startsWith('app/x-cache/') || rel === 'lib/cache-routing.ts' || !/\.(tsx?|json)$/.test(rel)) continue
  if (readFileSync(f, 'utf8').includes('x-cache')) check(false, `${rel}: mentions "x-cache" (the mirror folder must stay internal)`)
}
check(MIRROR_PREFIX === '/x-cache', 'MIRROR_PREFIX must match the folder app/x-cache')
check(existsSync(join(ROOT, 'middleware.ts')) && /decideRoute/.test(read('middleware.ts')) && /isCachingEnabled\(\)/.test(read('middleware.ts')), 'middleware.ts must call decideRoute with isCachingEnabled()')
{
  // The matcher must be literal strings (Next cannot read template literals) and must cover every mirrored path plus the mirror folder.
  const mw = read('middleware.ts')
  const matcherBlock = /matcher:\s*\[([\s\S]*?)\]/.exec(mw)?.[1] ?? ''
  check(!/`/.test(matcherBlock) && !/\$\{/.test(matcherBlock), 'middleware.ts: config.matcher must hold plain string literals, no template strings')
  const patterns = [...matcherBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const covers = (path: string) =>
    patterns.some((p) => {
      if (p.endsWith('/:path*')) return path === p.slice(0, -7) || path.startsWith(p.slice(0, -7) + '/')
      return p === path
    })
  for (const path of Object.keys(samplePaths)) check(covers(path.replace(/\/$/, '') || '/'), `middleware.ts matcher does not cover ${path}`)
  check(covers('/x-cache') && covers('/x-cache/blog'), 'middleware.ts matcher must cover the mirror folder (to redirect direct visits)')
  for (const p of ['/admin', '/api/preferences', '/links', '/thank-you', '/sitemap.xml', '/og/x', '/go/x']) check(!covers(p), `middleware.ts matcher must not cover ${p}`)
}
check(/CACHE_PUBLIC_PAGES/.test(read('.env.example')), '.env.example must document CACHE_PUBLIC_PAGES')

// ---------- 6. Switchers do a full reload ----------
for (const f of ['components/language-toggle.tsx', 'components/currency-toggle.tsx']) {
  const src = code(f)
  check(/window\.location\.reload\(\)/.test(src) && !/router\.refresh\(\)/.test(src), `${f}: must reload the page after setting the cookie (a soft refresh cannot switch between the cacheable and the cookie copy)`)
}
check(/LocaleEffects/.test(read('components/footer.tsx')), 'components/footer.tsx: draws the consent banner and sets <html lang> through LocaleEffects')

// ---------- 7. Build output (only when .next exists) ----------
const manifestPath = join(ROOT, '.next', 'prerender-manifest.json')
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { routes: Record<string, unknown>; dynamicRoutes: Record<string, unknown> }
  const known = new Set([...Object.keys(m.routes), ...Object.keys(m.dynamicRoutes)])
  for (const r of MIRRORED_ROUTES) {
    const route = r.folder ? `/x-cache/${r.folder}` : '/x-cache'
    const isDyn = r.folder.includes('[')
    // Static pages are in routes; dynamic ones (on-demand ISR) are in dynamicRoutes, from/[city] also has built paths.
    check(known.has(route) || isDyn && [...known].some((k) => k.startsWith(route.split('[')[0])), `build: ${route} is not in the prerender manifest, so it is rendered per request`)
  }
  // The real (cookie-reading) pages must stay per request: a real page in the manifest would mean it is cached across visitors.
  for (const r of MIRRORED_ROUTES) {
    const real = r.folder ? `/${r.folder}` : '/'
    if (real !== '/from/[city]') check(!known.has(real) || !!r.folder.includes('['), `build: the real page ${real} must not be prerendered (it reads the visitor's cookies)`)
  }
} else {
  console.log('(.next not found: skipped the build-output check; run next build first for the full guard)')
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} problem(s), ${passed} checks passed`)
  for (const f of failures) console.error(' - ' + f)
  process.exit(1)
}
console.log(`ok: ${passed} cache-loop checks passed`)
