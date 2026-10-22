// Offline check: the planned destination guides (lib/guide-plan.ts). Reads the supplied list and the config, no database.
// Run: pnpm dlx tsx scripts/check-guide-plan.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLANNED_PLACES,
  PLANNED_PLACE_RULE,
  PLAN_FILE_ALIASES,
  PLAN_SOURCE_NOTE,
  companyCandidatesFromSuppliers,
  guideScopeOf,
  kindFromCompanyName,
  orderPlannedPlaces,
  planRank,
  planSlug,
  planStatusRows,
  plannedAsCandidate,
  slugCovers,
  summarizePlan,
} from '../lib/guide-plan'
import { GUIDE_SEEDS } from '../lib/guide-seeds'
import { groupChildren, parentChain, type ScopeNode } from '../lib/guide-scope'
import { pickRelatedWithCoverage, type GuideLink } from '../lib/guides'

const EM = String.fromCharCode(8212)
const EN = String.fromCharCode(8211)
let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

// 1. Every country and place in the supplied file is in the config exactly once (or is a named alias).
const doc = read('docs/factory/GUIDE-PLAN-DESTINATIONS.md')
const docRows = doc.split(/\r?\n/).filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*Country/.test(l))
const docCountries: string[] = []
const docPlaces: { country: string; place: string }[] = []
for (const line of docRows) {
  const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length)
  const country = cells[0]
  docCountries.push(country)
  for (const place of (cells[1] ?? '').split(';').map((p) => p.trim()).filter(Boolean)) docPlaces.push({ country, place })
}
expect('the supplied file has rows to check', docCountries.length >= 29 && docPlaces.length >= 120, `${docCountries.length} countries, ${docPlaces.length} places`)

const bySlug = new Map<string, number>()
for (const p of PLANNED_PLACES) bySlug.set(p.slug, (bySlug.get(p.slug) ?? 0) + 1)
expect('no slug appears twice in the config', [...bySlug.values()].every((n) => n === 1), [...bySlug].filter(([, n]) => n > 1).map(([s]) => s).join(', '))
const resolve = (name: string) => planSlug(PLAN_FILE_ALIASES[name] !== undefined ? PLAN_FILE_ALIASES[name] : name)
const missingCountries = docCountries.filter((c) => {
  const slug = resolve(c)
  return slug && !PLANNED_PLACES.some((p) => p.scope === 'country' && p.slug === slug)
})
expect('every country in the file has exactly one country page', missingCountries.length === 0, missingCountries.join(', '))
const missingPlaces = docPlaces.filter(({ place }) => {
  if (PLAN_FILE_ALIASES[place] !== undefined) return false
  return !PLANNED_PLACES.some((p) => p.scope !== 'country' && p.slug === planSlug(place))
})
expect('every port, city and place in the file is in the config', missingPlaces.length === 0, missingPlaces.map((m) => m.place).join(', '))
const unexplained = docPlaces.filter(({ place }) => !!PLAN_FILE_ALIASES[place] && !PLANNED_PLACES.some((p) => p.slug === planSlug(PLAN_FILE_ALIASES[place])))
expect('every alias in the file points at a real page', unexplained.length === 0, unexplained.map((m) => m.place).join(', '))
const extra = PLANNED_PLACES.filter((p) => p.scope !== 'country' && !docPlaces.some((d) => planSlug(d.place) === p.slug))
expect('the config holds nothing that is not in the file', extra.length === 0, extra.map((e) => e.name).join(', '))
// A place listed under two countries is one page: the first country keeps it. Prove none is silently lost.
const docPlaceSlugs = docPlaces.map((d) => planSlug(d.place))
expect('no place is listed twice in the file (so none is merged away)', new Set(docPlaceSlugs).size === docPlaceSlugs.length, docPlaceSlugs.filter((s, i) => docPlaceSlugs.indexOf(s) !== i).join(', '))

// 2. Slugs: plain ASCII, diacritics stripped, display names kept.
expect('slugs are lowercase ASCII with single hyphens', PLANNED_PLACES.every((p) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)), PLANNED_PLACES.filter((p) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)).map((p) => p.slug).join(', '))
expect('Dürnstein, Ísafjörður, Chichén Itzá, Telašćica, Roatán, Ålesund, Kuşadası strip to plain slugs', planSlug('Dürnstein') === 'durnstein' && planSlug('Ísafjörður') === 'isafjordur' && planSlug('Chichén Itzá') === 'chichen-itza' && planSlug('Telašćica') === 'telascica' && planSlug('Roatán') === 'roatan' && planSlug('Ålesund') === 'alesund' && planSlug('Kuşadası') === 'kusadasi', [planSlug('Ísafjörður'), planSlug('Kuşadası')].join(' '))
expect('display names keep their accents', PLANNED_PLACES.find((p) => p.slug === 'durnstein')?.name === 'Dürnstein' && PLANNED_PLACES.find((p) => p.slug === 'saint-barthelemy')?.name === 'Saint Barthélemy')
expect('Türkiye uses the existing Turkey page name', PLANNED_PLACES.some((p) => p.slug === 'turkey' && p.scope === 'country') && !PLANNED_PLACES.some((p) => p.slug === 'turkiye'))
expect('every entry says where it came from and counts at least once', PLANNED_PLACES.every((p) => p.source === PLAN_SOURCE_NOTE && p.mentions >= 1 && p.kind === 'destinations'))

// 3. Scope and parents.
const countrySlugs = new Set(PLANNED_PLACES.filter((p) => p.scope === 'country').map((p) => p.slug))
expect('every non-country has a parent that is a country page', PLANNED_PLACES.filter((p) => p.scope !== 'country').every((p) => p.parent_slug && countrySlugs.has(p.parent_slug)))
expect('countries have no parent and the country scope', PLANNED_PLACES.filter((p) => p.scope === 'country').every((p) => p.parent_slug === null && guideScopeOf(p.scope) === 'country'))
expect('scope is one of country, city, port, attraction', PLANNED_PLACES.every((p) => ['country', 'city', 'port', 'attraction'].includes(p.scope)))
const scopeOf = (n: string) => PLANNED_PLACES.find((p) => p.slug === planSlug(n))?.scope
expect('named attractions are attractions', ['Plitvice Lakes', 'Blue Lagoon', 'Golden Circle', 'Keukenhof', 'Masada', 'Dead Sea', 'Chichén Itzá', 'Pompeii'].every((n) => scopeOf(n) === 'attraction'))
expect('named cruise ports are ports, towns are cities', ['Nassau', 'Civitavecchia', 'Piraeus', 'Southampton', 'Roatán'].every((n) => scopeOf(n) === 'port') && ['Salzburg', 'Bruges', 'Oia'].every((n) => scopeOf(n) === 'city'))
expect('an attraction has no scope label of its own (never a wrong one)', guideScopeOf('attraction') === null && guideScopeOf('port') === 'port')
const montenegro = PLANNED_PLACES.filter((p) => p.parent_slug === 'montenegro').map((p) => p.slug)
expect('Montenegro holds Kotor and Perast', montenegro.includes('kotor') && montenegro.includes('perast'))

// 4. Ordering: countries first (most planned places first), then cities and ports under a country that has a page, then the rest, then attractions.
const none = new Set<string>()
const ordered = orderPlannedPlaces(none)
const firstNonCountry = ordered.findIndex((p) => p.scope !== 'country')
expect('countries come first', ordered.slice(0, firstNonCountry).every((p) => p.scope === 'country') && ordered.slice(firstNonCountry).every((p) => p.scope !== 'country'))
const counts = ordered.slice(0, firstNonCountry).map((p) => p.places)
expect('countries are ordered by how many planned places they hold', counts.every((n, i) => i === 0 || counts[i - 1] >= n), counts.join(','))
expect('Italy (the most places) is the first country', ordered[0].slug === 'italy' && ordered[1].slug === 'croatia')
const lastCityIdx = Math.max(...ordered.map((p, i) => (p.scope === 'city' || p.scope === 'port' ? i : -1)))
const firstAttraction = ordered.findIndex((p) => p.scope === 'attraction')
expect('attractions come last', firstAttraction > lastCityIdx && ordered.slice(firstAttraction).every((p) => p.scope === 'attraction'))
const withItaly = orderPlannedPlaces(new Set(['italy']))
const firstCityOverall = withItaly.findIndex((p) => p.scope !== 'country')
expect('with Italy written, its cities come before cities of countries with no page', withItaly[firstCityOverall].parent_slug === 'italy' && planRank(withItaly[firstCityOverall], new Set(['italy'])) === 1)
expect('a city is never ranked ahead of a country', withItaly.slice(0, firstCityOverall).every((p) => p.scope === 'country'))
expect('ordering is stable and keeps every place once', ordered.length === PLANNED_PLACES.length && new Set(ordered.map((p) => p.slug)).size === PLANNED_PLACES.length)

// 5. No duplicates with the curated seeds; the planned set and the seeds together have no repeated destination slug.
const seedDestSlugs = GUIDE_SEEDS.filter((s) => s.kind === 'destinations').map((s) => planSlug(s.name))
const seedAlsoPlanned = seedDestSlugs.filter((s) => PLANNED_PLACES.some((p) => p.slug === s))
expect('seeds that are also planned keep one candidate (listGuideCandidates merges them by slug)', seedAlsoPlanned.length > 0 && new Set(seedDestSlugs).size === seedDestSlugs.length)
const guidesTs = read('lib/guides.ts')
expect('listGuideCandidates merges a planned place into the seed that already queued it', /const queued = out\.find\(\(c\) => c\.kind === 'destinations' && c\.slug === place\.slug\)/.test(guidesTs) && /queued\.parent_slug = place\.parent_slug/.test(guidesTs))
expect('seed parents agree with the plan', GUIDE_SEEDS.filter((s) => s.parent_slug && PLANNED_PLACES.some((p) => p.slug === planSlug(s.name))).every((s) => PLANNED_PLACES.find((p) => p.slug === planSlug(s.name))?.parent_slug === s.parent_slug))

// Variants of existing destinations and guides.
const cancun = PLANNED_PLACES.find((p) => p.slug === 'cancun')!
expect('"cancun-mexico" and "mexico-cancun" cover Cancun', slugCovers(cancun, 'cancun-mexico') && slugCovers(cancun, 'mexico-cancun') && slugCovers(cancun, 'cancun'))
expect('an unrelated slug does not cover it', !slugCovers(cancun, 'cozumel') && !slugCovers(cancun, 'mexico'))
const dubai = PLANNED_PLACES.find((p) => p.slug === 'dubai')!
expect('Dubai variants are covered', slugCovers(dubai, 'dubai-uae') && slugCovers(dubai, 'dubai'))
const croatia = PLANNED_PLACES.find((p) => p.slug === 'croatia')!
const italy = PLANNED_PLACES.find((p) => p.slug === 'italy')!
expect('a country is covered only by its own slug or alias, not by one of its cities', slugCovers(croatia, 'croatia') && !slugCovers(croatia, 'croatia-split') && !slugCovers(italy, 'rome-italy'))
expect('Turkiye and USA aliases cover their countries', slugCovers(PLANNED_PLACES.find((p) => p.slug === 'turkey')!, 'turkiye') && slugCovers(PLANNED_PLACES.find((p) => p.slug === 'united-states')!, 'usa'))
expect('nice is not covered by venice', !slugCovers(PLANNED_PLACES.find((p) => p.slug === 'nice')!, 'venice') && !slugCovers(PLANNED_PLACES.find((p) => p.slug === 'nice')!, 'venice-italy'))

// 6. Excluded respected, and the status table.
const rows = planStatusRows(
  [
    { kind: 'destinations', slug: 'italy', status: 'published' },
    { kind: 'destinations', slug: 'croatia', status: 'draft' },
    { kind: 'destinations', slug: 'cancun-mexico', status: 'published' },
    { kind: 'hotels', slug: 'dubai', status: 'published' },
  ],
  new Set(['destinations:bruges', 'destinations:italy']),
)
const st = (slug: string) => rows.find((r) => r.slug === slug)?.status
expect('status: a published guide is published', st('italy') === 'published')
expect('status: a draft is draft', st('croatia') === 'draft')
expect('status: a variant guide counts (cancun-mexico)', st('cancun') === 'published')
expect('status: the do-not-recreate list shows excluded', st('bruges') === 'excluded')
expect('status: an existing guide beats the excluded list', st('italy') === 'published')
expect('status: a guide of another kind with the same slug does not count', st('dubai') === 'waiting')
expect('status: anything else is waiting', st('vienna') === 'waiting')
const sum = summarizePlan(rows)
expect('summary: written = published + draft, and the parts add up', sum.written === sum.published + sum.draft && sum.written + sum.waiting + sum.excluded === sum.total && sum.excluded === 1, JSON.stringify(sum))

// The exclusion is honoured in listGuideCandidates by the shared `taken` set, before the plan loop.
const exIdx = guidesTs.indexOf("'guide_excluded'")
const planIdx = guidesTs.indexOf('orderPlannedPlaces(writtenDestinations)')
expect('the excluded list is read before the planned places are added', exIdx > 0 && planIdx > exIdx)
expect('a planned place is added only if it is not taken', /if \(taken\.has\(key\) \|\| coveredSlugs\.some/.test(guidesTs))
const cands = ordered.map(plannedAsCandidate)
expect('every planned candidate is a destination seed with its parent and the planned flag', cands.every((c) => c.kind === 'destinations' && c.origin === 'seed' && c.planned === true && (c.parent_slug === null) === (c.scope === 'country')))

// 7. Link graph: planned pages link up to the country page and to siblings, and are never orphans.
const links: GuideLink[] = [italy, ...PLANNED_PLACES.filter((p) => p.parent_slug === 'italy')].map((p, i) => ({ id: `g${i}`, kind: 'destinations', slug: p.slug, name: p.name, parent_slug: p.parent_slug, summary: '', related_package_ids: [], scope: guideScopeOf(p.scope) }))
const nodes: ScopeNode[] = links.map((l) => ({ kind: l.kind, slug: l.slug, name: l.name, parent_slug: l.parent_slug, scope: l.scope }))
const rome = links.find((l) => l.slug === 'rome')!
expect('a city page has the country as its parent in the trail', parentChain(rome, nodes).map((n) => n.slug).join() === 'italy')
const inbound = new Map<string, number>(links.map((l) => [l.slug, 0]))
for (const l of links) for (const r of pickRelatedWithCoverage(l, links, 6)) inbound.set(r.slug, (inbound.get(r.slug) ?? 0) + 1)
expect('every planned page gets at least one inbound related link (no orphans)', [...inbound.values()].every((n) => n >= 1), JSON.stringify([...inbound]))
expect('the country page lists its cities, ports and attractions as children', groupChildren({ kind: 'destinations', slug: 'italy' }, nodes, (k) => k).length > 0)
expect('a city links to the country page and to siblings', pickRelatedWithCoverage(rome, links, 6).some((r) => r.slug === 'italy') && pickRelatedWithCoverage(rome, links, 6).filter((r) => r.parent_slug === 'italy').length >= 2)

// 8. Companies and hotels from stored package data only.
const found = companyCandidatesFromSuppliers([
  { name: 'Sandals Royal Bahamian: 7 nights', supplier: 'Sandals Resorts', destination: 'Nassau, Bahamas', category: 'Resort' },
  { name: 'Danube trip', supplier: 'Viking River Cruises', destination: 'Vienna', category: 'River cruise' },
  { name: 'Alaska trip', supplier: 'Holland America Line', destination: 'Juneau', category: 'Cruise' },
  { name: 'Hotel stay', supplier: 'Grand Plaza Hotel', destination: 'Nassau, Bahamas', category: 'Hotel' },
  { name: 'Bus tour', supplier: 'Globus', destination: 'Rome', category: 'Tour' },
  { name: 'dup', supplier: 'Sandals Resorts', destination: 'Nassau, Bahamas', category: 'Resort' },
  { name: 'none', supplier: null, destination: null, category: null },
  { name: 'digits', supplier: 'Cruise 2027 Special', destination: null, category: null },
])
const kinds = Object.fromEntries(found.candidates.map((c) => [c.name, c.kind]))
expect('suppliers become the right kinds from their own words', kinds['Sandals Resorts'] === 'resorts' && kinds['Viking River Cruises'] === 'river-cruises' && kinds['Holland America Line'] === 'cruise-lines' && kinds['Grand Plaza Hotel'] === 'hotels', JSON.stringify(kinds))
expect('names are kept exactly as stored and not repeated', found.candidates.filter((c) => c.name === 'Sandals Resorts').length === 1 && found.candidates.every((c) => c.from === 'supplier'))
expect('a hotel sits under its destination, a cruise line has no parent', found.candidates.find((c) => c.name === 'Grand Plaza Hotel')?.parent_slug === 'nassau-bahamas' && found.candidates.find((c) => c.name === 'Holland America Line')?.parent_slug === null)
expect('a bare brand is reported, never made a candidate', found.unmapped.includes('Globus') && !found.candidates.some((c) => c.name === 'Globus'))
expect('a name with digits or no text is skipped', !found.candidates.some((c) => /2027/.test(c.name)) && !found.unmapped.some((n) => /2027/.test(n)))
expect('a plain trip title is not a company kind', kindFromCompanyName('Alaska Adventure') === null && kindFromCompanyName('Blue Line Tours') === null)
const sup = read('lib/guides.ts')
expect('supplier names feed the candidate list as origin package (never auto-published as a guess)', /companyCandidatesFromSuppliers\(rows\)/.test(sup) && /origin: 'package', scope: inferScope\(c\.kind, c\.name\)/.test(sup))

// 9. Safety: the writer is told a planned trip is not a visit; the rule reaches both prompts and the brief.
const composer = read('lib/guide-composer.ts')
const run = read('lib/guide-run.ts')
expect('the rule forbids visit claims, client claims, itineraries and arrangement claims', /we visited/.test(PLANNED_PLACE_RULE) && /our clients loved/.test(PLANNED_PLACE_RULE) && /NOT evidence/.test(PLANNED_PLACE_RULE) && /itinerary/.test(PLANNED_PLACE_RULE) && /we can help you plan a group trip/.test(PLANNED_PLACE_RULE))
expect('the rule is in the article prompt and the enrich prompt', (composer.match(/\$\{plannedRule\(brief\)\}/g) ?? []).length === 2)
expect('the brief carries the planned flag from the candidate', /\.\.\.\(cand\.planned \? \{ planned: true \} : \{\}\)/.test(run))
expect('the rule has no digits and no em dash', !/\d/.test(PLANNED_PLACE_RULE) && !PLANNED_PLACE_RULE.includes(EM) && !PLANNED_PLACE_RULE.includes(EN))

// 11. Visibility.
const card = read('components/admin/guides-automation-card.tsx')
const route = read('app/api/admin/posts/automation/route.ts')
expect('the Automation card shows "Planned guides: N written, M waiting" and "could not be read"', /Planned guides: \{data\.planned/.test(card) && /written, \$\{data\.planned\.summary\.waiting\} waiting/.test(card) && /"could not be read"/.test(card))
expect('the card lists the planned guides with a status per place', /Planned destination guides/.test(card) && /r\.status/.test(card))
expect('the route reads the plan status read-only and falls back to null', /readPlanStatus\(admin\)\.catch\(\(\) => null\)/.test(route) && /listUnguidedCompanies\(admin\)\.catch\(\(\) => null\)/.test(route))
const status = read('lib/guide-plan-status.ts')
expect('the status module never writes', !/\.(insert|update|upsert|delete)\(/.test(status))

// 12. No em dashes in the new or changed files.
const files = ['lib/guide-plan.ts', 'lib/guide-plan-status.ts', 'scripts/check-guide-plan.ts', 'components/admin/guides-automation-card.tsx', 'app/api/admin/posts/automation/route.ts']
const bad = files.filter((f) => read(f).includes(EM))
expect('no em dashes in the new files', bad.length === 0, bad.join(', '))
expect('the plan config has no en dashes either', !read('lib/guide-plan.ts').includes(EN))

console.log(`\nPlanned places: ${PLANNED_PLACES.length} (${PLANNED_PLACES.filter((p) => p.scope === 'country').length} countries, ${PLANNED_PLACES.filter((p) => p.scope === 'city').length} cities, ${PLANNED_PLACES.filter((p) => p.scope === 'port').length} ports, ${PLANNED_PLACES.filter((p) => p.scope === 'attraction').length} attractions)`)
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
