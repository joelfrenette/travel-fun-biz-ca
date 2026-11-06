// Offline self-check: every public page type shows a visible breadcrumb trail AND carries a matching BreadcrumbList.
// Background: the SEO playbook check "breadcrumb-schema" samples one guide, one post and one trip page. Upcoming trip pages had
// neither a trail nor the data (only past-trip recaps did), and blog / destination / best-time / compare pages had the data
// (some only when written copy existed) but no visible trail. Read from the page source; no network, no database.
// Run: corepack pnpm dlx tsx scripts/check-breadcrumb-coverage.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

// ---- the shared component ----
const comp = read('components/breadcrumbs.tsx')
check('component: trail and BreadcrumbList from one list', /buildBreadcrumbJsonLd/.test(comp) && /aria-label="Breadcrumb"/.test(comp))
check('component: schema={false} draws the trail only (no duplicate list)', /schema = true/.test(comp) && /{schema && <script/.test(comp))

// ---- trips ----
const trip = read('app/packages/[slug]/page.tsx')
check('trip page: past AND upcoming trips both render <Breadcrumbs>', count(trip, /<Breadcrumbs crumbs=/g) >= 2, count(trip, /<Breadcrumbs crumbs=/g))
// the upcoming branch is the one holding <TripKitPage; the trail must come before it
const upcomingAt = trip.indexOf('<TripKitPage ')
const upcomingTrail = trip.lastIndexOf('<Breadcrumbs crumbs=', upcomingAt)
check('trip page: the upcoming branch has its trail before the Trip Kit', upcomingAt > 0 && upcomingTrail > trip.indexOf(') : ('), { upcomingAt, upcomingTrail })

// ---- blog ----
const blog = read('app/blog/[slug]/page.tsx')
check('blog post: visible trail from the shared component', /<Breadcrumbs crumbs=/.test(blog) && /currentPath=\{`\/blog\/\$\{post\.slug\}`\}/.test(blog))
check('blog post: no hand-written second BreadcrumbList', !/"BreadcrumbList"/.test(blog))

// ---- destinations ----
const dest = read('app/destinations/[slug]/page.tsx')
check('destination page: visible trail rendered', /<Breadcrumbs/.test(dest))
check('destination page: data comes from guideJsonLd when a guide exists, from the component otherwise (never both)', /schema=\{!guide\}/.test(dest) && /guideJsonLd\(guide, trail\)/.test(dest))

// ---- best-time and compare: always, not only when written copy exists ----
for (const [label, file, path] of [['best-time', 'app/best-time-to-visit/[destination]/page.tsx', '/best-time-to-visit/'], ['compare', 'app/compare/[pair]/page.tsx', '/compare/']] as const) {
  const src = read(file)
  check(`${label} page: visible trail rendered`, /<Breadcrumbs crumbs=/.test(src) && src.includes(`currentPath={\`${path}`))
  check(`${label} page: BreadcrumbList is not gated on written copy`, !/buildBreadcrumbJsonLd/.test(src))
}

// ---- pages that already had both: keep them so ----
const guide = read('components/guide-page.tsx')
check('guide pages (hotels, resorts, ships, cruise lines, river cruises, yachts): trail and BreadcrumbList', /aria-label="Breadcrumb"/.test(guide) && /"BreadcrumbList"/.test(guide) && /guideJsonLd\(guide, trail\)/.test(guide))
check('guide index pages: trail and BreadcrumbList', /aria-label="Breadcrumb"/.test(read('components/guide-index-page.tsx')) && /"BreadcrumbList"/.test(read('components/guide-index-page.tsx')))
for (const f of ['app/from/[city]/page.tsx', 'app/travel-advisories/page.tsx', 'app/travel-advisories/[country]/page.tsx', 'app/agents/page.tsx', 'app/agents/[slug]/page.tsx']) {
  const src = read(f)
  check(`${f}: trail and BreadcrumbList`, /aria-label="Breadcrumb"/.test(src) && /buildBreadcrumbJsonLd/.test(src))
}

// ---- the audit names the page that lacks it ----
check('audit: the breadcrumb check names the sampled pages that lack it', /missing on \$\{lacking\}/.test(read('lib/seo-playbook-audit.ts')))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
