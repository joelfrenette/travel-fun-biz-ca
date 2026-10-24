// Speed budget guard (speed loop). Offline: reads source files, and the .next build output when it exists.
// Fails loudly with the file name when a speed rule is broken, so a slow change is caught before it ships.
//
//   pnpm dlx tsx scripts/check-speed-budget.ts
//
// Part 1 (always): source rules. The main photo of a page loads first, below-the-fold photos are lazy, fonts use
//   display swap, nothing heavy (the newsletter form, admin code) leaks into the code every public page downloads,
//   and Google Analytics only loads through the consent component.
// Part 2 (only when .next exists): first-load JavaScript (gzipped, layout included) per public route stays under a
//   budget = the measured baseline of 2026-10-22 plus 10 percent.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = process.cwd()
const failures: string[] = []
let passed = 0

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}
function check(ok: boolean, file: string, message: string) {
  if (ok) passed++
  else failures.push(`${file}: ${message}`)
}

// ---------------------------------------------------------------- Part 1: source rules

// 1. Fonts: display swap (explicit or the next/font default), never block or fallback, and no per-weight file list.
{
  const f = 'app/layout.tsx'
  const src = read(f)
  check(/Inter\(\{/.test(src), f, 'the Inter font setup was not found')
  check(!/display:\s*["'](block|fallback|optional)["']/.test(src), f, 'font display must be "swap" (text must show while the font loads)')
  check(/display:\s*["']swap["']/.test(src), f, 'set display: "swap" on the font')
  check(!/weight:\s*\[/.test(src), f, 'do not list font weights; Inter is variable, a weight list downloads and declares each one separately')
  check(!/<link[^>]+fonts\.googleapis\.com/.test(src), f, 'do not link Google Fonts by hand (render-blocking); use next/font')
}

// 2. Home hero photo is the LCP: priority, and Next sizes it.
{
  const f = 'components/hero-section.tsx'
  const src = read(f)
  check(/priority=\{index === 0\}/.test(src) || /\bpriority\b/.test(src), f, 'the first hero slide must have priority')
  check(/<Image[\s\S]*?fill/.test(src), f, 'the hero photo should use next/image (fill) so it gets srcset and modern formats')
}

// 3. Main photos of the page types: high priority and explicit dimensions (no layout shift).
for (const f of ['app/blog/[slug]/page.tsx', 'components/guide-page.tsx']) {
  const src = read(f)
  const heroImg = src.match(/<img[^>]*fetchPriority="high"[^>]*>/s)
  check(!!heroImg, f, 'the main photo needs fetchPriority="high"')
  if (heroImg) check(/width=\{\d+\}/.test(heroImg[0]) && /height=\{\d+\}/.test(heroImg[0]), f, 'the main photo needs explicit width and height')
}
{
  // The trip page draws its hero in components/trip (upcoming: trip-kit-hero, past trip: past-trip-hero).
  for (const f of ['components/trip/trip-kit-hero.tsx', 'components/trip/past-trip-hero.tsx']) check(/<img[^>]*fetchPriority="high"/.test(read(f)), f, 'the trip page hero photo needs fetchPriority="high"')
}
{
  const f = 'app/destinations/[slug]/page.tsx'
  check(/<img[\s\S]{0,400}fetchPriority="high"[\s\S]{0,200}>/.test(read(f)), f, 'the destination guide photo needs fetchPriority="high"')
}

// 4. Trip cards are lazy unless asked (a card below the fold must not be preloaded against the main photo).
{
  const f = 'components/package-card.tsx'
  const src = read(f)
  check(/eager\s*=\s*false/.test(src), f, 'PackageCard must default to a lazy photo (eager = false)')
  check(/loading=\{eager \? "eager" : "lazy"\}/.test(src), f, 'PackageCard photo must use loading lazy unless eager')
  check(/width=\{\d+\}/.test(src) && /height=\{\d+\}/.test(src), f, 'PackageCard photo needs width and height')
}
{
  const f = 'components/trip-gallery.tsx'
  check(/loading="lazy"/.test(read(f)), f, 'gallery thumbnails must be lazy')
}

// 5. Blog covers are served resized (not the 900 KB original) on the post page and the list.
for (const f of ['app/blog/[slug]/page.tsx', 'app/blog/page.tsx']) {
  check(/postImageSrcSet\(/.test(read(f)), f, 'blog cover photos must use postImageSrcSet (resized copies via /_next/image)')
}

// 6. Heavy code stays out of every page: the footer loads the newsletter form lazily, layout/header/footer never import
//    admin code, and next.config keeps the modern image formats.
for (const f of ['components/footer.tsx', 'components/header.tsx', 'app/layout.tsx']) {
  const src = read(f)
  check(!/from\s+["']@\/components\/newsletter-form["']/.test(src), f, 'must not import newsletter-form directly (react-hook-form + zod); use components/lazy-newsletter-form')
  check(!/from\s+["']@\/components\/admin\//.test(src) && !/from\s+["']@\/app\/admin/.test(src), f, 'must not import admin code into a public layout')
  check(!/from\s+["'](react-hook-form|zod|recharts)["']/.test(src), f, 'must not import react-hook-form, zod or recharts into a layout every page loads')
}
{
  const f = 'next.config.mjs'
  check(/image\/avif/.test(read(f)), f, 'images.formats should list image/avif before image/webp')
}

// 7. Third-party scripts: GA only through the consent component; no beforeInteractive / hand-written script tags with src.
{
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`
      const abs = join(ROOT, rel)
      if (statSync(abs).isDirectory()) {
        if (rel === 'app/admin' || rel === 'components/admin' || rel.startsWith('app/api')) continue
        walk(rel)
      } else if (/\.tsx?$/.test(name)) {
        const src = readFileSync(abs, 'utf8')
        if (/strategy=["']beforeInteractive["']/.test(src)) offenders.push(`${rel} (beforeInteractive script blocks first paint)`)
        if (/<script[^>]+\bsrc=/.test(src) && !/application\/ld\+json/.test(src.match(/<script[^>]+\bsrc=[^>]*>/)?.[0] ?? '')) offenders.push(`${rel} (script tag with src in markup)`)
        if (/googletagmanager\.com/.test(src) && rel !== 'components/consent-analytics.tsx') offenders.push(`${rel} (loads Google tag outside the consent component)`)
      }
    }
  }
  walk('app')
  walk('components')
  check(offenders.length === 0, 'app/ components/', `third-party script rule broken: ${offenders.join('; ')}`)
}

// ---------------------------------------------------------------- Part 2: first-load JS from the build output

// Baseline gzipped first-load JS in kB (layout + route chunks, measured on the build of 2026-10-22 before the speed
// changes) and the budget = baseline + 10 percent. A route not listed uses DEFAULT_BUDGET_KB.
const BASELINE_KB: Record<string, number> = {
  '/page': 193.7,
  '/blog/page': 183.6,
  '/blog/[slug]/page': 193.1,
  '/destinations/[slug]/page': 193.1,
  '/packages/[slug]/page': 194.3,
  '/packages/page': 187.2,
  '/from/[city]/page': 190.2,
  '/links/page': 126.9,
}
const DEFAULT_BUDGET_KB = Math.round(Math.max(...Object.values(BASELINE_KB)) * 1.1)

const manifestPath = join(ROOT, '.next', 'app-build-manifest.json')
const sizes: string[] = []
if (existsSync(manifestPath)) {
  const pages = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { pages: Record<string, string[]> }).pages
  const layout = pages['/layout'] ?? []
  const gz = (file: string) => gzipSync(readFileSync(join(ROOT, '.next', file))).length / 1000
  for (const [route, files] of Object.entries(pages)) {
    if (!route.endsWith('/page') || route.includes('/admin') || route.includes('/api/')) continue
    const js = [...new Set([...layout, ...files])].filter((f) => f.endsWith('.js'))
    const kb = js.reduce((sum, f) => sum + gz(f), 0)
    const budget = BASELINE_KB[route] ? Math.round(BASELINE_KB[route] * 1.1 * 10) / 10 : DEFAULT_BUDGET_KB
    sizes.push(`${route.padEnd(36)} ${kb.toFixed(1).padStart(6)} kB (budget ${budget})`)
    check(kb <= budget, `.next (route ${route})`, `first-load JS is ${kb.toFixed(1)} kB gzipped, over the ${budget} kB budget; something heavy was added to this page or to the layout`)
  }
} else {
  console.log('No .next build output found: skipped the first-load JS budget (run next build first to check it).')
}

if (sizes.length) console.log(sizes.join('\n'))
if (failures.length) {
  console.error(`\nSPEED BUDGET FAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\ncheck-speed-budget: ${passed} checks passed`)
