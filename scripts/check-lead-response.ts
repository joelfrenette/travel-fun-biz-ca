// Offline check: a saved lead shows the visitor success even if GoHighLevel failed.
// Behavioural on the helper, plus a wiring check on the three routes.
// Run: pnpm dlx tsx scripts/check-lead-response.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLeadResponse } from '../lib/lead-response'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const a = resolveLeadResponse({ saved: true, ghlOk: true })
expect('saved + ghl ok => success 200, nothing to retry', a.success && a.status === 200 && !a.retryLater, JSON.stringify(a))

const b = resolveLeadResponse({ saved: true, ghlOk: false, ghlError: 'GHL timeout' })
expect('saved + ghl failed => success 200, row stays unforwarded (retryLater)', b.success && b.status === 200 && b.retryLater, JSON.stringify(b))

const c = resolveLeadResponse({ saved: false, ghlOk: true })
expect('not saved + ghl ok => success 200', c.success && c.status === 200 && !c.retryLater, JSON.stringify(c))

const d = resolveLeadResponse({ saved: false, ghlOk: false, ghlError: 'GHL timeout' })
expect('not saved + ghl failed => 502', !d.success && d.status === 502, JSON.stringify(d))

const e = resolveLeadResponse({ saved: false, ghlOk: false, ghlError: 'GoHighLevel is not configured' })
expect('not saved + ghl not configured => 503', !e.success && e.status === 503, JSON.stringify(e))

const f = resolveLeadResponse({ saved: true, ghlOk: false, ghlError: 'GoHighLevel is not configured' })
expect('saved + ghl not configured => still success 200', f.success && f.status === 200, JSON.stringify(f))

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
for (const p of ['app/api/submit-lead/route.ts', 'app/api/newsletter/route.ts', 'app/api/trip-alerts/route.ts']) {
  const src = read(p)
  expect(`${p} calls resolveLeadResponse`, src.includes('resolveLeadResponse('))
  expect(`${p} uses the helper status, no hard-coded 5xx on ghl failure`, !/result\.error\.includes\(['"]not configured['"]\)/.test(src) && /status: outcome\.status/.test(src))
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll lead-response checks passed')
