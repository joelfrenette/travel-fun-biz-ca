// Offline check: the AI spend tripwire alerts only above the ceiling, once a day, and never throws.
// Run: pnpm dlx tsx scripts/check-ai-tripwire.ts   (exit 1 on a failure)
import { parseCeiling, overCeiling, buildAiAlert, readAiSpend, runAiTripwire, parseStoredSpend, readStoredAiSpend, AI_SPEND_KEY, AI_CEILING_DEFAULT_USD, AI_ALERTED_DAY_KEY } from '../lib/ai-tripwire'
import { plainAction, AI_SPEND_ISSUE_ID } from '../lib/plain-steps'

let failures = 0
function expect(name: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const NOW = Date.parse('2026-10-21T12:00:00Z')

expect('default ceiling is 5', AI_CEILING_DEFAULT_USD === 5 && parseCeiling(null) === 5 && parseCeiling('') === 5)
expect('junk, zero and negative fall back to 5', parseCeiling('abc') === 5 && parseCeiling('0') === 5 && parseCeiling('-3') === 5)
expect('a valid ceiling is used', parseCeiling(' 12.5 ') === 12.5)
expect('over only when strictly above', overCeiling(5.01, 5) && !overCeiling(5, 5) && !overCeiling(0, 5) && !overCeiling(NaN, 5))

const mail = buildAiAlert(7.234, 5)
expect('alert names spend and ceiling, no em dashes', /\$7\.23/.test(mail.lines.join(' ')) && /\$5\.00/.test(mail.lines.join(' ')) && !/[—–]/.test(mail.subject + mail.lines.join('')))

// Fake database: app_settings and api_calls.
function fake(opts: { settings?: Record<string, string>; costs?: number[]; failCalls?: boolean; throwAll?: boolean }) {
  const settings = { ...(opts.settings ?? {}) }
  const client = {
    from(table: string) {
      if (opts.throwAll) throw new Error('db down')
      if (table === 'app_settings') {
        return {
          select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: key in settings ? { value: settings[key] } : null, error: null }) }) }),
          upsert: async (row: { key: string; value: string }) => {
            settings[row.key] = row.value
            return { error: null }
          },
        }
      }
      if (table === 'api_calls') {
        return {
          select: () => ({ gte: () => ({ range: async (from: number) => (opts.failCalls ? { data: null, error: { message: 'x' } } : { data: (opts.costs ?? []).slice(from, from + 1000).map((c) => ({ est_cost_usd: c })), error: null }) }) }),
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
  return { client: client as never, settings }
}

async function main() {
  const under = fake({ costs: [1, 1.5, 0.25] })
  const r = await readAiSpend(under.client, NOW)
  expect('spend adds up', r.spend === 2.75 && r.ceiling === 5)
  expect('unreadable api_calls is null, not 0', (await readAiSpend(fake({ failCalls: true }).client, NOW)).spend === null)
  expect('custom ceiling setting is read', (await readAiSpend(fake({ settings: { ai_daily_ceiling_usd: '2' }, costs: [1] }).client, NOW)).ceiling === 2)

  const origErr = console.error
  console.error = () => {}
  expect('under ceiling: no alert, no write', (await runAiTripwire(under.client, NOW)) === '' && !(AI_ALERTED_DAY_KEY in under.settings))
  expect('a total DB failure never throws', (await runAiTripwire(fake({ throwAll: true }).client, NOW)) === '')
  expect('unreadable spend: quiet', (await runAiTripwire(fake({ failCalls: true }).client, NOW)) === '')
  console.error = origErr

  // Over the ceiling with email unconfigured: reports not-configured, does not mark the day.
  delete process.env.RESEND_API_KEY
  const over = fake({ costs: [4, 3] })
  const msg = await runAiTripwire(over.client, NOW)
  expect('over ceiling reports it (not-configured mail)', /over \$5\.00/.test(msg) && /not-configured/.test(msg) && !(AI_ALERTED_DAY_KEY in over.settings))

  // Already emailed today: no second send.
  const again = fake({ costs: [4, 3], settings: { [AI_ALERTED_DAY_KEY]: '2026-10-21' } })
  expect('already alerted today: no second email', /already emailed today/.test(await runAiTripwire(again.client, NOW)))

  // Sent path with a stubbed Resend call: marks the day, then a rerun does not send again.
  process.env.RESEND_API_KEY = 'test'
  process.env.ADMIN_EMAIL = 'a@example.test'
  let sends = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    sends++
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const live = fake({ costs: [4, 3] })
  await runAiTripwire(live.client, NOW)
  await runAiTripwire(live.client, NOW + 3600_000)
  globalThis.fetch = realFetch
  expect('exactly one email for a noisy day', sends === 1 && live.settings[AI_ALERTED_DAY_KEY] === '2026-10-21')

  expect('the shared 6h alert throttle is not moved by the tripwire email', !('autopilot_last_alert_at' in live.settings))
  const stored = JSON.parse(live.settings[AI_SPEND_KEY])
  expect('cron stored the 24h reading', stored.spend === 7 && stored.at === new Date(NOW + 3600_000).toISOString())
  const fresh = parseStoredSpend(live.settings[AI_SPEND_KEY], NOW + 30 * 3600_000)
  expect('stored reading is fresh at 30h', fresh?.spend === 7)
  expect('stored reading is ignored at 40h, junk, and missing', parseStoredSpend(live.settings[AI_SPEND_KEY], NOW + 40 * 3600_000) === null && parseStoredSpend('junk', NOW) === null && parseStoredSpend(null, NOW) === null)
  const rs = await readStoredAiSpend(live.client, NOW + 3600_000)
  expect('admin list reads the stored value only', rs.spend === 7 && rs.ceiling === 5)
  const quiet = fake({ costs: [1] })
  await runAiTripwire(quiet.client, NOW)
  expect('under ceiling still stores the reading (so the item clears)', JSON.parse(quiet.settings[AI_SPEND_KEY]).spend === 1)

  const pa = plainAction({ id: AI_SPEND_ISSUE_ID, area: 'setup', title: 'AI use is above your daily limit', detail: 'x' })
  expect('plain steps exist, grade-5 style, no em dashes', pa.steps.length >= 4 && !/[—–]/.test(pa.why + pa.steps.join('')) && /ai_daily_ceiling_usd/.test(pa.steps.join(' ')))

  if (failures) {
    console.log(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
