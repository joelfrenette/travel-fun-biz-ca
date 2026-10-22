// Offline check: consent-gated lead-source measurement (referrer host, landing path, utm_term).
// Run: pnpm dlx tsx scripts/check-lead-touch.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { touchFromAttribution, hasTouch, isMissingTouchColumn, insertWithTouchFallback, referrerHost, landingPathOnly } from '../lib/lead-touch'
import { getAttribution } from '../lib/attribution'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

async function main() {
  // Declined / no consent: the browser sends only page_path, so nothing is recorded.
  const declined = touchFromAttribution({ page_path: '/contact' } as never)
  expect('declined payload records nothing', !hasTouch(declined) && declined.referrer === null && declined.landing_path === null && declined.utm_term === null)
  expect('undefined attribution records nothing', !hasTouch(touchFromAttribution(undefined)))

  // Consent granted: host only, path only.
  const t = touchFromAttribution({ referrer: 'https://www.Google.com/search?q=secret+trip', landing_path: '/guides/cancun?utm_source=x#top', utm_term: ' cancun deals ' })
  expect('referrer reduced to host', t.referrer === 'google.com', String(t.referrer))
  expect('landing path loses query and hash', t.landing_path === '/guides/cancun', String(t.landing_path))
  expect('utm_term trimmed', t.utm_term === 'cancun deals')
  expect('junk referrer gives null', referrerHost('not a url') === null && referrerHost('') === null)
  expect('non-path landing gives null', landingPathOnly('https://evil.example/x') === null)

  // Client gate: with no consent stored, getAttribution returns page_path only (no window in node = empty object).
  expect('getAttribution without a browser sends nothing extra', Object.keys(getAttribution()).every((k) => k === 'page_path'))
  const src = readFileSync('lib/attribution.ts', 'utf8')
  expect('client still gates extras on analytics consent', /if \(!analyticsConsented\(\)\) return \{ page_path/.test(src))

  // Missing-column detection
  expect('42703 detected', isMissingTouchColumn({ code: '42703', message: 'column "referrer" of relation "leads" does not exist' }))
  expect('PGRST204 detected', isMissingTouchColumn({ code: 'PGRST204', message: "Could not find the 'utm_term' column of 'leads' in the schema cache" }))
  expect('unrelated error not treated as missing column', !isMissingTouchColumn({ code: '23505', message: 'duplicate key' }) && !isMissingTouchColumn(null))

  // Fail open: first insert fails on missing column, second without the new fields succeeds.
  const calls: Record<string, unknown>[] = []
  const missing = await insertWithTouchFallback({ name: 'a' }, t, async (row) => {
    calls.push(row)
    return 'referrer' in row ? { data: null, error: { code: '42703', message: 'column "referrer" does not exist' } } : { data: { id: '1' }, error: null }
  })
  expect('retries without new fields on missing column', calls.length === 2 && !('referrer' in calls[1]) && !missing.error)

  // No retry for other errors; no extra fields when nothing consented.
  const c2: Record<string, unknown>[] = []
  const other = await insertWithTouchFallback({ name: 'a' }, t, async (row) => (c2.push(row), { data: null, error: { code: '23505', message: 'dup' } }))
  expect('other errors are not retried', c2.length === 1 && !!other.error)
  const c3: Record<string, unknown>[] = []
  await insertWithTouchFallback({ name: 'a' }, declined, async (row) => (c3.push(row), { data: { id: '1' }, error: null }))
  expect('declined insert has none of the new columns', c3.length === 1 && !('referrer' in c3[0]) && !('landing_path' in c3[0]) && !('utm_term' in c3[0]))

  // Migration is additive and idempotent.
  const sql = readFileSync('supabase/migrations/0051_leads_source_measurement.sql', 'utf8').toLowerCase()
  expect('migration is additive + idempotent', (sql.match(/add column if not exists/g) ?? []).length === 3 && !/drop |not null/.test(sql.replace(/--.*$/gm, '')))

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
main()
