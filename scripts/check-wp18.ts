// Offline checks for WP18 (KPI honesty, auto-approve, heal re-try, page copy default, guide social release,
// GA4 visits). Run: pnpm dlx tsx scripts/check-wp18.ts
import { readFileSync } from 'node:fs'
import { latestRollingImpressions } from '../lib/funnel'
import { sumDimensionRows } from '../lib/search-console'
import { activePlatformsOf } from '../lib/social-provider'
import { autoApproveDecision, summariseAutoApprovals } from '../lib/blog-topics'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failed++
}
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

// ---- A: KPI honesty ----
check('funnel awareness uses the latest rolling row, never a sum',
  latestRollingImpressions([{ day: '2026-10-10', impressions: 1000 }, { day: '2026-10-12', impressions: 1200 }, { day: '2026-10-11', impressions: 1100 }]) === 1200)
check('funnel awareness with no rows is 0', latestRollingImpressions([]) === 0)
check('funnel awareness with null impressions is 0', latestRollingImpressions([{ day: '2026-10-12', impressions: null }]) === 0)
check('funnel query reads one row, latest first', /order\('day', \{ ascending: false \}\)\.limit\(1\)/.test(src('lib/funnel.ts')))

const named = sumDimensionRows([{ clicks: 3, impressions: 40 }, { clicks: 1, impressions: 10 }])
check('sumDimensionRows adds a report', named.clicks === 4 && named.impressions === 50)
const sc = src('lib/search-console.ts')
check('ranking snapshot totals come from the page report', /const totals = pages\.length \? pageTotals : namedQueryTotals/.test(sc))

const admin = src('app/admin/page.tsx')
check('admin home has no sample numbers or fake badges', !/sampleData|sampleChannels|1,247|\+12%|\+8%|\+23%/.test(admin))
check('admin home shows the honest not-connected state with a Setup link', /Google Analytics is not connected/.test(admin) && /Open the Setup steps/.test(admin))
check('admin home never labels data as sample', !/Sample Data/i.test(admin))

check('self-healing card says checklist score, not a Google ranking', /not a Google ranking/.test(src('components/admin/self-healing-card.tsx')))
check('keyword ideas say opportunity estimate', /opportunity estimate/.test(src('app/admin/keywords/page.tsx')))

check('active networks with GHL come from ghl_accounts, not the stale list',
  activePlatformsOf('ghl', [{ id: '1', platform: 'Facebook', name: 'a' }, { id: '2', platform: 'facebook', name: 'b' }, { id: '3', platform: 'linkedin', name: 'c' }], ['bluesky']).join(',') === 'facebook,linkedin')
check('active networks with Upload-Post come from its list', activePlatformsOf('upload-post', [{ id: '1', platform: 'x', name: 'a' }], ['Bluesky', ' threads ']).join(',') === 'bluesky,threads')
check('System Health text says 15 minutes', /after 15 minutes/.test(src('lib/plain-steps.ts')) && !/after 30 minutes/.test(src('lib/plain-steps.ts')))
check('publishing a guide clears stale quality_notes', /status === 'published' \? \{ status, quality_notes: null/.test(src('lib/guides.ts')))

// ---- B: auto-approve engine ideas ----
const good = { score: 72, packageSlug: 'sandy-toes', blockers: [] as string[] }
check('B: good idea with a small backlog is approved', autoApproveDecision(good, 3).approve)
check('B: score 69 stays suggested', !autoApproveDecision({ ...good, score: 69 }, 3).approve)
check('B: score exactly 70 is approved', autoApproveDecision({ ...good, score: 70 }, 0).approve)
check('B: no grounding package stays suggested', !autoApproveDecision({ ...good, packageSlug: null }, 3).approve)
check('B: any blocker stays suggested', !autoApproveDecision({ ...good, blockers: ['uses a superlative'] }, 3).approve)
check('B: backlog of 10 stops auto-approval', !autoApproveDecision(good, 10).approve && autoApproveDecision(good, 9).approve)
check('B: unreadable backlog fails closed', !autoApproveDecision(good, null).approve)
check('B: missing score stays suggested', !autoApproveDecision({ ...good, score: null }, 0).approve)
const entries = [{ at: new Date(Date.now() - 86_400_000).toISOString(), keyword: 'a', score: 80, reason: 'x' }, { at: new Date(Date.now() - 20 * 86_400_000).toISOString(), keyword: 'b', score: 75, reason: 'x' }]
check('B: auto-approved summary counts 7 days and all', summariseAutoApprovals(entries).total === 2 && summariseAutoApprovals(entries).last7 === 1)
const ki = src('lib/keyword-intel.ts')
check('B: engine inserts approved only through the decision', /status: decision\.approve \? 'approved' : 'suggested'/.test(ki) && /recordAutoApprovals\(admin, approvals\)/.test(ki))
check('B: autopilot API exposes the auto-approved count', /autoApproved: summariseAutoApprovals/.test(src('app/api/admin/autopilot/route.ts')))

console.log(failed ?`\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
