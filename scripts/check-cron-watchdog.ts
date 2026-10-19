// Offline check: the autopilot watchdog alerts only when the run is stale, Autopilot is on and not paused.
// Run: pnpm dlx tsx scripts/check-cron-watchdog.ts   (exit 1 on a failure)
import { decideWatchdog, runCronWatchdog } from '../lib/cron-watchdog'
import { judgeCron } from '../lib/cron-health'

let failures = 0
const out: string[] = []
function expect(name: string, ok: boolean) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const NOW = Date.parse('2026-10-19T12:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString()
const stale = judgeCron('autopilot', { at: ago(5), ok: true }, NOW)
const fresh = judgeCron('autopilot', { at: ago(0.2), ok: true }, NOW)
const problem = judgeCron('autopilot', { at: ago(0.2), ok: false, note: 'x' }, NOW)
const missing = judgeCron('autopilot', undefined, NOW)

{
  const a = decideWatchdog(stale, 'on', false)
  expect('stale + on + not paused alerts', !!a && a.subject.includes('stopped running'))
  expect('alert has exactly 3 steps', a?.steps.length === 3)
  expect('steps mention Cron tab, CRON_SECRET, Redeploy', !!a && /Cron tab/.test(a.steps[0]) && /CRON_SECRET/.test(a.steps[1]) && /Redeploy/.test(a.steps[2]))
  expect('no em dashes in subject or steps', !!a && ![a.subject, ...a.steps].some((s) => /[—–]/.test(s)))
}
expect('fresh run: none', decideWatchdog(fresh, 'on', false) === null)
expect('autopilot off: none', decideWatchdog(stale, 'off', false) === null)
expect('autopilot unset: none', decideWatchdog(stale, null, false) === null)
expect('paused: none', decideWatchdog(stale, 'on', true) === null)
expect('amber from a reported problem (not stale): none', problem.light === 'amber' && decideWatchdog(problem, 'on', false) === null)
expect('missing heartbeat: none, no throw', missing.light === 'gray' && decideWatchdog(missing, 'on', false) === null)
expect('null judgement: none, no throw', decideWatchdog(null, 'on', false) === null && decideWatchdog(undefined, 'on', false) === null)

// Fake database: cron heartbeat rows and settings.
function fake(settings: Record<string, string>, opts: { throwOnRead?: boolean } = {}) {
  const writes: string[] = []
  const client = {
    from(table: string) {
      if (table !== 'app_settings') throw new Error('unexpected table ' + table)
      return {
        select() {
          if (opts.throwOnRead) throw new Error('db down')
          const q: Record<string, unknown> = {}
          q.in = (_c: string, keys: string[]) => Promise.resolve({ data: keys.filter((k) => k in settings).map((k) => ({ key: k, value: settings[k] })) })
          q.eq = (_c: string, key: string) => ({ maybeSingle: async () => ({ data: key in settings ? { value: settings[key] } : null }) })
          return q
        },
        upsert: async (row: { key: string }) => { writes.push(row.key); return { error: null } },
      }
    },
  }
  return { client: client as never, writes }
}

async function main() {
  const heartbeat = (h: number) => JSON.stringify({ at: ago(h), ok: true })
  const realFetch = globalThis.fetch
  const sent: { subject: string; text: string }[] = []
  process.env.RESEND_API_KEY = 'test'
  process.env.ADMIN_EMAIL = 'admin@example.org'
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({}) }
  }) as never

  try {
    let f = fake({ 'cron_last_run:autopilot': heartbeat(5), autopilot_mode: 'on' })
    let r = await runCronWatchdog(f.client, NOW)
    expect('stale + on: one email sent with the subject and 3 numbered steps', sent.length === 1 && sent[0].subject === 'Autopilot has stopped running' && /1\) .*\n2\) .*\n3\) /.test(sent[0].text))
    expect('only the alert bookkeeping settings were written', f.writes.length > 0 && f.writes.every((k) => k === 'autopilot_last_alert_at' || k === 'mail_last_error'))
    expect('result note mentions the alert', r.includes('alert sent'))

    sent.length = 0
    f = fake({ 'cron_last_run:autopilot': heartbeat(0.1), autopilot_mode: 'on' })
    r = await runCronWatchdog(f.client, NOW)
    expect('fresh run: nothing sent, nothing written', sent.length === 0 && f.writes.length === 0 && r === '')

    f = fake({ 'cron_last_run:autopilot': heartbeat(5), autopilot_mode: 'off' })
    await runCronWatchdog(f.client, NOW)
    expect('autopilot off: nothing sent', sent.length === 0)

    f = fake({ 'cron_last_run:autopilot': heartbeat(5), autopilot_mode: 'on', automation_paused: 'true' })
    await runCronWatchdog(f.client, NOW)
    expect('kill switch set: nothing sent', sent.length === 0)

    f = fake({ autopilot_mode: 'on' })
    let threw = false
    try { r = await runCronWatchdog(f.client, NOW) } catch { threw = true }
    expect('missing heartbeat: no throw, nothing sent', !threw && sent.length === 0)

    f = fake({}, { throwOnRead: true })
    threw = false
    try { r = await runCronWatchdog(f.client, NOW) } catch { threw = true }
    expect('database read failure: no throw, nothing sent', !threw && sent.length === 0 && r === '')
  } finally {
    globalThis.fetch = realFetch
  }

  console.log(out.join('\n'))
  if (failures) {
    console.log(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll cron watchdog checks passed')
}
main()
