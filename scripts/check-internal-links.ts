// Offline self-check: advisory, compare and destination pages link to each other, only on exact slug matches.
// Run: corepack pnpm dlx tsx scripts/check-internal-links.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareLinksForDestination, destinationHubForCountry } from '../lib/internal-links'

let failed = 0
function check(label: string, ok: boolean, extra?: unknown) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const pairs = [
  { pairSlug: 'italy-vs-tahiti', destinationA: 'Italy', destinationB: 'Tahiti' },
  { pairSlug: 'greece-vs-italy', destinationA: 'Greece', destinationB: 'Italy' },
  { pairSlug: 'greece-vs-tahiti', destinationA: 'Greece', destinationB: 'Tahiti' },
]
const it = compareLinksForDestination('italy', 'Italy', pairs)
check('destination -> compare: both pairs containing italy', it.length === 2 && it[0].path === '/compare/italy-vs-tahiti' && it[1].path === '/compare/greece-vs-italy', it)
check('destination -> compare: label names the other side', it[0].label === 'Italy vs Tahiti' && it[1].label === 'Italy vs Greece', it)
check('destination -> compare: no pair, no link', compareLinksForDestination('japan', 'Japan', pairs).length === 0)
check('destination -> compare: a non-canonical pair slug is never linked', compareLinksForDestination('italy', 'Italy', [{ pairSlug: 'tahiti-vs-italy', destinationA: 'Italy', destinationB: 'Tahiti' }]).length === 0)
check('destination -> compare: limit respected', compareLinksForDestination('italy', 'Italy', pairs, 1).length === 1)

const pk = [{ destination: 'Italy' }, { destination: null }, { destination: 'Costa Rica' }]
check('advisory -> destination: exact slug match', destinationHubForCountry(pk, 'italy')?.path === '/destinations/italy')
check('advisory -> destination: multi-word destination', destinationHubForCountry(pk, 'costa-rica')?.path === '/destinations/costa-rica')
check('advisory -> destination: no trip, no link', destinationHubForCountry(pk, 'france') === null)

const adv = read('app/travel-advisories/[country]/page.tsx')
check('advisory page uses destinationHubForCountry and renders the hub link', /destinationHubForCountry\(/.test(adv) && /hub\.path/.test(adv))
const cmp = read('app/compare/[pair]/page.tsx')
check('compare page links the advisory page of each side via the cacheable switch client', /loadAdvisoryLinkForGuide\(s, getSupabaseAdminForPageSwitch\(\)\)/.test(cmp) && /advisoryLinks\.map/.test(cmp))
check('compare page never imports next/headers', !/next\/headers/.test(cmp))
const dest = read('app/destinations/[slug]/page.tsx')
check('destination page renders compare links from the real pair list', /compareLinksForDestination\(params\.slug/.test(dest) && /compareLinks\.map/.test(dest))
check('link helper imports nothing that reads the database', !/supabase|next\/headers/.test(read('lib/internal-links.ts')))

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
