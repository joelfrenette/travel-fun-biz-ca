// Offline check: the instant lead reply (default OFF, one per email per 24h, never throws).
// Run: pnpm dlx tsx scripts/check-lead-ack.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { sendLeadAck, buildLeadAckEmail, isValidAckEmail, ackFirstName, ackSentKey, isRateLimited, LEAD_ACK_SETTING_KEY } from '../lib/lead-ack'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

function rig(on: boolean, fetchOk = true) {
  const store = new Map<string, string>()
  if (on) store.set(LEAD_ACK_SETTING_KEY, 'true')
  const sent: { from: string; to: string[]; subject: string; text: string }[] = []
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    return { ok: fetchOk, status: fetchOk ? 200 : 500 }
  }) as unknown as typeof fetch
  let t = new Date('2026-10-20T12:00:00Z')
  return {
    sent,
    store,
    advance: (ms: number) => void (t = new Date(t.getTime() + ms)),
    deps: { fetchImpl, get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => void store.set(k, v), now: () => t },
  }
}

async function main() {
  process.env.RESEND_API_KEY = 're_test'
  process.env.LEAD_ACK_FROM_EMAIL = 'hello@mail.example.org'
  const lead = { email: 'Jane.Doe@Example.org', name: 'Jane Doe' }

  { const r = rig(false); const res = await sendLeadAck(lead, r.deps); expect('default OFF sends nothing', res === 'off' && r.sent.length === 0) }
  { const r = rig(true); const res = await sendLeadAck(lead, r.deps); expect('ON sends once to the lead', res === 'sent' && r.sent.length === 1 && r.sent[0].to[0] === lead.email) }
  { const r = rig(true); const res = await sendLeadAck({ ...lead, isTest: true }, r.deps); expect('test rows skipped', res === 'test' && r.sent.length === 0) }
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', 'x@y.com, z@y.com']) {
    const r = rig(true)
    const res = await sendLeadAck({ email: bad, name: 'X' }, r.deps)
    expect(`invalid email skipped: ${JSON.stringify(bad)}`, res === 'invalid-email' && r.sent.length === 0)
  }
  {
    const r = rig(true)
    await sendLeadAck(lead, r.deps)
    const again = await sendLeadAck({ ...lead, email: lead.email.toUpperCase() }, r.deps)
    expect('second send within 24h (any case) is rate limited', again === 'rate-limited' && r.sent.length === 1)
    r.advance(24 * 60 * 60 * 1000 + 1000)
    const later = await sendLeadAck(lead, r.deps)
    expect('allowed again after 24h', later === 'sent' && r.sent.length === 2)
  }
  { const r = rig(true, false); const res = await sendLeadAck(lead, r.deps); expect('provider failure returns failed, no throw', res === 'failed') }
  {
    const r = rig(true)
    const boom = { ...r.deps, fetchImpl: (async () => { throw new Error('network down') }) as unknown as typeof fetch }
    const res = await sendLeadAck(lead, boom)
    expect('network error never throws', res === 'failed')
    const thrower = { ...r.deps, get: async () => { throw new Error('db down') } }
    expect('settings read error never throws', (await sendLeadAck(lead, thrower)) === 'failed')
  }
  {
    delete process.env.LEAD_ACK_FROM_EMAIL
    const r = rig(true)
    expect('no sender address configured sends nothing', (await sendLeadAck(lead, r.deps)) === 'not-configured' && r.sent.length === 0)
    process.env.LEAD_ACK_FROM_EMAIL = 'hello@mail.example.org'
  }

  // Copy
  const mail = buildLeadAckEmail('Jane Doe')
  expect('greets by first name', mail.text.startsWith('Hi Jane,'))
  expect('junk name falls back to there', ackFirstName('<script>') === 'there' && ackFirstName('') === 'there')
  expect('no em or en dashes in copy', !/[–—]/.test(mail.subject + mail.text))
  expect('no response-time promise', !/(within|hours|minutes|24|same day|shortly|right away|immediately)/i.test(mail.text))
  expect('footer names sender, address and phone', /TravelFunBiz/.test(mail.text) && /Toronto/.test(mail.text) && /\(833\)/.test(mail.text))
  expect('footer says how to stop', /reply to this email/i.test(mail.text))
  expect('rate key hides the address', !ackSentKey('a@b.com').includes('a@b') && ackSentKey('A@B.com') === ackSentKey('a@b.com'))
  expect('isRateLimited handles junk', !isRateLimited(null, new Date()) && !isRateLimited('junk', new Date()))
  expect('plain valid email accepted', isValidAckEmail('jane@example.org'))

  const copy = readFileSync('lib/lead-ack-copy.ts', 'utf8')
  expect('copy file marked DRAFT pending CASL review', /DRAFT.*CASL review/.test(copy.split('\n')[0]))
  const route = readFileSync('app/api/submit-lead/route.ts', 'utf8')
  expect('submit-lead calls the ack after the save, guarded by leadId', /if \(leadId\) await sendLeadAck/.test(route))

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
main()
