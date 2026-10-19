// Offline check: the new lead email. Behavioural, with an in-memory settings store and a fake fetch.
// Run: pnpm dlx tsx scripts/check-new-lead-alert.ts   (exit 1 on a failure)
import { notifyNewLead, decideNewLeadNotice, buildNewLeadEmail, parseDayCount, NEW_LEAD_DAILY_CAP } from '../lib/alerts'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

function rig() {
  const store = new Map<string, string>()
  const sent: { subject: string; text: string; to: string[] }[] = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }) as unknown as typeof fetch
  return {
    store,
    sent,
    deps: {
      fetchImpl,
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      now: () => new Date('2026-10-18T12:00:00Z'),
    },
  }
}

async function main() {
  const prevKey = process.env.RESEND_API_KEY
  const prevTo = process.env.NOTIFY_TO_EMAIL
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.NOTIFY_TO_EMAIL = 'owner@example.org'

  // pure decision
  expect('decide: test row skipped', decideNewLeadNotice({ isTest: true, alreadyClaimed: false, sentToday: 0 }) === 'test')
  expect('decide: claimed id is a duplicate', decideNewLeadNotice({ alreadyClaimed: true, sentToday: 0 }) === 'duplicate')
  expect('decide: 20th allowed', decideNewLeadNotice({ alreadyClaimed: false, sentToday: NEW_LEAD_DAILY_CAP - 1 }) === 'send')
  expect('decide: 21st refused', decideNewLeadNotice({ alreadyClaimed: false, sentToday: NEW_LEAD_DAILY_CAP }) === 'cap')
  expect('day counter resets on a new day', parseDayCount('2026-10-17:20', '2026-10-18') === 0 && parseDayCount('2026-10-18:7', '2026-10-18') === 7 && parseDayCount('junk', '2026-10-18') === 0)

  // test rows skipped
  let r = rig()
  expect('test row: nothing sent', (await notifyNewLead({ id: 't1', isTest: true, package: 'Cruise' }, r.deps)) === 'test' && r.sent.length === 0)

  // same lead id once
  r = rig()
  const first = await notifyNewLead({ id: 'a1', package: 'Cancun', utmSource: 'facebook' }, r.deps)
  const second = await notifyNewLead({ id: 'a1', package: 'Cancun', utmSource: 'facebook' }, r.deps)
  expect('same lead id notifies once', first === 'sent' && second === 'duplicate' && r.sent.length === 1, `${first}/${second}/${r.sent.length}`)
  expect('goes to the notify address', r.sent[0]?.to?.[0] === 'owner@example.org')

  // 21st in a day refused, next day allowed
  r = rig()
  const results: string[] = []
  for (let i = 0; i < 21; i++) results.push(await notifyNewLead({ id: `lead-${i}`, package: 'P' }, r.deps))
  expect('first 20 sent, 21st refused', results.slice(0, 20).every((x) => x === 'sent') && results[20] === 'cap' && r.sent.length === 20, results.join(','))
  const tomorrow = await notifyNewLead({ id: 'lead-next', package: 'P' }, { ...r.deps, now: () => new Date('2026-10-19T08:00:00Z') })
  expect('cap resets the next day', tomorrow === 'sent')

  // no personal data in subject or body, even if the free text tries
  r = rig()
  await notifyNewLead(
    { id: 'pii1', package: 'Jane Doe jane@x.com 5195551234', pagePath: '/packages/cancun', utmSource: 'ig 12345678', ...({ name: 'Jane Doe', email: 'jane@x.com', phone: '5195551234' } as object) },
    r.deps,
  )
  const mail = r.sent[0]
  const blob = `${mail?.subject}\n${mail?.text}`
  expect('email built', !!mail && mail.subject === 'New lead')
  expect('no @ in subject or body', !blob.includes('@'), blob)
  expect('no digit run of 7 or more', !/\d{7,}/.test(blob), blob)
  expect('links to /admin/leads', /\/admin\/leads/.test(blob))
  const direct = buildNewLeadEmail({ id: 'z', package: null, pagePath: '/p/x', utmSource: null }, 'https://www.travelfunbiz.ca/admin/leads')
  expect('page path used when no package; missing utm says so', direct.text.includes('/p/x') && direct.text.includes('Source: not recorded'))

  // missing key never throws
  delete process.env.RESEND_API_KEY
  r = rig()
  let threw = false
  let out = ''
  try {
    out = await notifyNewLead({ id: 'k1', package: 'X' }, r.deps)
  } catch {
    threw = true
  }
  expect('missing API key returns without throwing or sending', !threw && out === 'not-configured' && r.sent.length === 0 && r.store.size === 0, out)

  // a throwing store never throws out
  process.env.RESEND_API_KEY = 're_test_key'
  let threw2 = false
  try {
    await notifyNewLead({ id: 'e1' }, { ...r.deps, get: async () => { throw new Error('db down') } })
  } catch {
    threw2 = true
  }
  expect('a failing settings read never throws', !threw2)

  if (prevKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = prevKey
  if (prevTo === undefined) delete process.env.NOTIFY_TO_EMAIL
  else process.env.NOTIFY_TO_EMAIL = prevTo

  if (failures) {
    console.log(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll checks passed')
}

main()
