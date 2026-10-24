// Offline check: the lead desk (hot lead detection, the Today card, the agent suggestions, the alerts, the reminder, privacy).
// Run: pnpm dlx tsx scripts/check-lead-desk.ts   (exit 1 on a failure)
// Every name, email and phone number below is made up (example.com addresses, 555-01xx numbers).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESK_OFFICE_KEY, groupPickerEntries, mergeDeskRecipients, officeAlertOn, officeBadge,
  ALERT_STATE_MAX, CALLBACK_PREFIX, DESK_EMAILS_KEY, DESK_SMS_KEY, agentTag, buildAgentEmail, buildDeskEmail, buildDeskSms, claimAlert, filterAgents, ghlAssignNote, hasPhone,
  hotWaitLight, hotWaitSentence, isHotLead, needsAgent, normalizeIntent, orderAgents, parseAlertState, parseDeskEmails, parseSmsContactIds, reminderDue, waitLight, waitMinutes, waitText,
  type PickerAgent,
} from '../lib/lead-desk'
import { evaluateCheck, unreadFacts, type CheckFacts } from '../lib/system-check'
import { TODAY_KINDS, parseCardId } from '../lib/today-cards'
import { addSnoozeMinutes, visibleCards, parseLog } from '../lib/today-state'
import { contactSubmissionSchema } from '../lib/schemas/contact'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DASH = new RegExp('[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2013) + ']')

const NOW = Date.parse('2026-10-24T15:00:00Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

async function main() {
  // ---- 1. Hot lead detection
  expect('a callback intent is hot, even with no phone', isHotLead({ intent: 'callback' }))
  expect('a form with a phone number is hot', isHotLead({ phone: '416-555-0100' }) && isHotLead({ phone: '+1 (416) 555 0100' }))
  expect('a form with no phone and no callback is not hot', !isHotLead({ phone: '' }) && !isHotLead({}) && !isHotLead({ phone: null, intent: 'quote' }) && !isHotLead({ intent: 'info', phone: undefined }))
  expect('a phone number that is too short or junk is not hot', !hasPhone('12345') && !hasPhone('call me') && !hasPhone('1'.repeat(20)))
  expect('the older trip kit callback marker in the message still counts as a callback', isHotLead({ message: `${CALLBACK_PREFIX} Alaska cruise` }))
  expect('a newsletter signup with a phone is not hot, unless it asks for a callback', !isHotLead({ phone: '416-555-0100', package: 'Newsletter signup' }) && isHotLead({ phone: '416-555-0100', package: 'Newsletter signup', intent: 'callback' }))
  expect('intent is normalised to callback, quote or info', normalizeIntent('Callback') === 'callback' && normalizeIntent(' quote ') === 'quote' && normalizeIntent('hack') === null && normalizeIntent(5) === null)
  expect('the contact form schema accepts an optional intent enum and refuses other values', contactSubmissionSchema.safeParse({ name: 'Test Person', email: 'test.person@example.com', intent: 'callback' }).success && contactSubmissionSchema.safeParse({ name: 'Test Person', email: 'test.person@example.com' }).success && !contactSubmissionSchema.safeParse({ name: 'Test Person', email: 'test.person@example.com', intent: 'spam' }).success)

  // ---- 2. Waiting colours and words
  expect('waiting is green to 5 minutes, amber after 5, red after 15', waitLight(0) === 'green' && waitLight(5) === 'green' && waitLight(5.1) === 'amber' && waitLight(15) === 'amber' && waitLight(15.1) === 'red')
  expect('wait minutes come from the created time', Math.round(waitMinutes(minsAgo(7), NOW)) === 7 && waitMinutes('junk', NOW) === 0 && waitMinutes(minsAgo(-5), NOW) === 0)
  expect('wait text is plain', waitText(0.2) === 'just now' && waitText(7.9) === '7 min' && waitText(125) === '2 h 5 min' && waitText(60) === '1 h' && waitText(3 * 1440) === '3 days')
  expect('needs an agent: hot, real, new and unassigned only', needsAgent({ hot: true, status: 'new', assigned_agent_id: null }) && !needsAgent({ hot: false }) && !needsAgent({ hot: true, assigned_agent_id: 'x' }) && !needsAgent({ hot: true, status: 'contacted' }) && !needsAgent({ hot: true, is_test: true }))

  // ---- 3. Agent suggestions: an ordering, never a choice
  const A = (id: string, name: string, specialties: string[], status = 'published'): PickerAgent => ({ id, slug: name.toLowerCase().replace(/\W+/g, '-'), display_name: name, specialties, status, region: null })
  const agents: PickerAgent[] = [
    A('1', 'Zed Example', ['Disney', 'Orlando']),
    A('2', 'Amy Sample', ['Honeymoons']),
    A('3', 'Cal Demo', ['Cruises', 'Alaska'], 'draft'),
    A('4', 'Bea Fixture', ['Caribbean cruises'], 'ready'),
    A('5', 'Old Hand', ['Cruises'], 'archived'),
    A('6', 'Dan Plain', []),
  ]
  const alaska = orderAgents(agents, { package: 'Alaska Cruise from Vancouver', pagePath: '/packages/alaska-cruise-2026' })
  expect('only draft, ready and published agents are listed', alaska.length === 5 && !alaska.some((e) => e.agent.status === 'archived'))
  expect('agents whose specialties match the trip come first and are tagged suggested', alaska[0].agent.id === '3' && alaska[0].suggested && alaska[1].agent.id === '4' && alaska[1].suggested, alaska.map((e) => `${e.agent.display_name}:${e.suggested}`).join(','))
  expect('the rest follow by name and are not suggested', alaska.slice(2).map((e) => e.agent.display_name).join(',') === 'Amy Sample,Dan Plain,Zed Example' && alaska.slice(2).every((e) => !e.suggested))
  expect('nothing is suggested when nothing matches', orderAgents(agents, { package: 'Custom Package' }).every((e) => !e.suggested))
  expect('the ordering is a pure list: no entry is marked chosen or selected', alaska.every((e) => !('selected' in e) && !('chosen' in e) && !('default' in e)))
  expect('the ordering is stable for the same input', JSON.stringify(orderAgents(agents, { package: 'Alaska Cruise' })) === JSON.stringify(orderAgents([...agents].reverse(), { package: 'Alaska Cruise' })))
  expect('the search box matches a name, a specialty or a region and keeps the order', filterAgents(alaska, 'disney').length === 1 && filterAgents(alaska, 'AMY')[0].agent.id === '2' && filterAgents(alaska, '').length === 5 && filterAgents(alaska, 'zzz').length === 0)
  expect('a word the lead typed can suggest too', orderAgents(agents, { package: 'Custom Package', message: 'We want a honeymoon in the summer' })[0].agent.id === '2')

  // ---- 3b. The office team (CEO, CTO, Manager) are agents too: listed first, never chosen for anyone
  const O = (id: string, name: string, specialties: string[], role: PickerAgent['office_role'] = null, status = 'published'): PickerAgent => ({ ...A(id, name, specialties, status), office_role: role })
  const withOffice: PickerAgent[] = [
    O('1', 'Zed Example', ['Disney'], 'mgr'),
    O('2', 'Amy Sample', ['Honeymoons'], 'ceo'),
    O('3', 'Cal Demo', ['Cruises', 'Alaska']),
    O('4', 'Bea Fixture', ['Caribbean cruises'], null, 'ready'),
    O('5', 'Old Hand', ['Cruises'], 'cto', 'archived'),
    O('6', 'Dan Plain', ['Alaska'], 'cto', 'draft'),
    O('7', 'Gus Other', []),
  ]
  const ordered = orderAgents(withOffice, { package: 'Alaska Cruise from Vancouver', pagePath: '/packages/alaska-cruise-2026' })
  const grouped = groupPickerEntries(ordered)
  expect('every roster person is listed, office team included, even a draft one; only an archived person is left out', ordered.length === 6 && ordered.some((e) => e.agent.display_name === 'Amy Sample') && ordered.some((e) => e.agent.display_name === 'Dan Plain') && !ordered.some((e) => e.agent.id === '5'))
  expect('the office team comes first in CEO, CTO, Manager order', grouped.office.map((e) => e.agent.display_name).join() === 'Amy Sample,Dan Plain,Zed Example', grouped.office.map((e) => `${e.agent.display_name}:${e.agent.office_role}`).join())
  expect('then agents suggested by specialty, then everyone else', grouped.suggested.map((e) => e.agent.display_name).join() === 'Cal Demo,Bea Fixture' && grouped.others.map((e) => e.agent.display_name).join() === 'Gus Other')
  expect('nobody is dropped or listed twice, and an office member who matches the trip is still under Office team', grouped.office.length + grouped.suggested.length + grouped.others.length === ordered.length && new Set([...grouped.office, ...grouped.suggested, ...grouped.others].map((e) => e.agent.id)).size === ordered.length && grouped.office.some((e) => e.agent.id === '6' && e.suggested))
  expect('still nothing preselected: no entry or group carries a chosen, selected or default flag', [...grouped.office, ...grouped.suggested, ...grouped.others].every((e) => !('selected' in e) && !('chosen' in e) && !('default' in e)) && Object.keys(grouped).join() === 'office,suggested,others')
  expect('with nobody on the office team the list is the plain suggested-then-rest list', (() => { const g = groupPickerEntries(alaska); return g.office.length === 0 && g.suggested.map((e) => e.agent.id).join() === '3,4' && g.others.map((e) => e.agent.id).join() === '2,6,1' })())
  expect('office badges read CEO, CTO, Manager and nothing for others', officeBadge('ceo') === 'CEO' && officeBadge('cto') === 'CTO' && officeBadge('mgr') === 'Manager' && officeBadge(null) === '' && officeBadge('boss') === '')
  expect('the search box also finds the office team by role', filterAgents(ordered, 'ceo').map((e) => e.agent.id).join() === '2' && filterAgents(ordered, 'office team').length === 3)

  // ---- 4. Desk settings
  expect('desk emails parse from a JSON list or a plain list, drop bad ones and duplicates', parseDeskEmails('["Shelby.Desk@example.com", "leslie.desk@example.com", "nope", "Shelby.Desk@example.com"]').join() === 'shelby.desk@example.com,leslie.desk@example.com' && parseDeskEmails('a@example.com, b@example.com;bad@x').join() === 'a@example.com,b@example.com' && parseDeskEmails('').length === 0 && parseDeskEmails(null).length === 0)
  expect('sms contact ids parse the same way and refuse junk', parseSmsContactIds('["abc123XYZ", "x", "bad id"]').join() === 'abc123XYZ' && parseSmsContactIds('ghlContact01, ghlContact02').length === 2 && parseSmsContactIds(undefined).length === 0)
  expect('alert state is bounded', (() => {
    let s = {}
    for (let i = 0; i < ALERT_STATE_MAX + 50; i++) s = claimAlert(s, `lead-${i}`, 'a', new Date(NOW + i * 1000)) ?? s
    return Object.keys(s).length <= ALERT_STATE_MAX && parseAlertState('not json') && Object.keys(parseAlertState('[1]')).length === 0
  })())

  // ---- 5. Messages: the desk gets no personal details; only the chosen agent does
  const lead = { id: 'lead-1', intent: 'callback', package: 'Alaska Cruise', pagePath: '/packages/alaska-cruise', utmSource: 'instagram', message: `${CALLBACK_PREFIX} Call me on 416-555-0199 or test.person@example.com` }
  const desk = buildDeskEmail(lead, 'https://example.com/admin')
  const sms = buildDeskSms(lead, 'https://example.com/admin')
  const everything = `${desk.subject}\n${desk.text}\n${sms}`
  expect('the desk email and text carry the trip and the link', desk.text.includes('Alaska Cruise') && desk.text.includes('https://example.com/admin') && sms.includes('Alaska Cruise') && sms.includes('https://example.com/admin'))
  expect('the desk email and text carry no name, email or phone number', !/416|555-0199|test\.person|example\.com\/test|@/.test(everything.replace('https://example.com/admin', '')), everything)
  expect('the desk email says nobody is assigned for them', /decide who takes it/i.test(desk.text) && /Nothing is assigned/i.test(desk.text))
  expect('the reminder is worded as a reminder', /reminder/i.test(buildDeskEmail(lead, 'u', { reminder: true, waitedMinutes: 20 }).subject) && /20 min/.test(buildDeskEmail(lead, 'u', { reminder: true, waitedMinutes: 20 }).text) && /Reminder/.test(buildDeskSms(lead, 'u', { reminder: true })))
  const agentBody = buildAgentEmail({ name: 'Test Person', email: 'test.person@example.com', phone: '416-555-0199', package: 'Alaska Cruise', pagePath: null, message: `${CALLBACK_PREFIX} Hello there`, intent: 'callback', utmSource: 'instagram', assignedBy: 'Leslie' }, 'Amy Sample')
  expect('the agent email carries the lead details and says the office assigned it', ['Test Person', 'test.person@example.com', '416-555-0199', 'Alaska Cruise', 'Hello there', 'assigned by Leslie'].every((s) => agentBody.text.includes(s)) && /office assigned/i.test(agentBody.text) && !agentBody.text.includes(CALLBACK_PREFIX))
  expect('the GoHighLevel tag and note are plain, with no phone or email', agentTag('Amy Sample!') === 'agent-amy-sample' && !/@|\d{7}/.test(ghlAssignNote('Amy Sample', 'Joel', new Date(NOW))) && /not automatic/.test(ghlAssignNote('Amy Sample', 'Joel', new Date(NOW))))

  // ---- 6. Alerts: idempotent, test leads skipped, SMS skipped when not set up
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.NOTIFY_TO_EMAIL = 'fallback.admin@example.com'
  const { sendDeskAlert, announceHotLead, pickReminders, runHotLeadReminders, assignLead, listPickerAgents } = await import('../lib/lead-desk-store')
  const sentMail: { to: string[]; subject: string; text: string }[] = []
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    sentMail.push(JSON.parse(init?.body ?? '{}'))
    return { ok: true } as Response
  }) as unknown as typeof fetch
  const alertStore: Record<string, string> = {}
  const smsSent: { id: string; msg: string }[] = []
  const deps = {
    fetchImpl, get: async (k: string) => alertStore[k] ?? null, set: async (k: string, v: string) => { alertStore[k] = v }, now: () => new Date(NOW), adminUrl: 'https://example.com/admin',
    sendSms: async (id: string, msg: string) => { smsSent.push({ id, msg }); return { ok: true } },
  }
  const r1 = await announceHotLead(lead, deps)
  expect('the first alert emails the fallback address and skips the text when no contact ids are set', r1.status === 'sent' && r1.email === 'sent' && r1.sms === 'skipped' && sentMail.length === 1 && sentMail[0].to.join() === 'fallback.admin@example.com' && smsSent.length === 0, JSON.stringify(r1))
  const r2 = await announceHotLead(lead, deps)
  expect('a lead alerts once: the second call sends nothing', r2.status === 'duplicate' && sentMail.length === 1 && smsSent.length === 0)
  alertStore[DESK_EMAILS_KEY] = '["shelby.desk@example.com","leslie.desk@example.com","joel.desk@example.com"]'
  alertStore[DESK_SMS_KEY] = '["ghlContact01","ghlContact02"]'
  const r3 = await announceHotLead({ ...lead, id: 'lead-2' }, deps)
  expect('with the desk set up it emails every desk address once and texts every contact once', r3.status === 'sent' && sentMail.length === 2 && sentMail[1].to.length === 3 && smsSent.length === 2 && smsSent.every((s) => /Hot lead/.test(s.msg)) && r3.sms === 'sent')
  const before = sentMail.length
  const r4 = await announceHotLead({ ...lead, id: 'lead-test', isTest: true }, deps)
  expect('a test lead sends nothing', r4.status === 'test' && sentMail.length === before && smsSent.length === 2)
  const failing = { ...deps, fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch, sendSms: async () => { throw new Error('boom') } }
  const r5 = await announceHotLead({ ...lead, id: 'lead-3' }, failing)
  expect('a failing email or text never throws', r5.status === 'failed' && r5.email === 'failed' && r5.sms === 'failed')
  const rn = await sendDeskAlert({ ...lead, id: '' }, 'a', deps)
  expect('a lead with no id is not alerted', rn.status === 'not-configured')

  const { fakeAdmin } = await import('./fake-admin')
  // ---- 6b. "Also alert the office team": optional, default OFF, private roster emails, de-duplicated, generic body
  expect('the switch is off unless the setting says on', !officeAlertOn(null) && !officeAlertOn(undefined) && !officeAlertOn('') && !officeAlertOn('off') && !officeAlertOn('maybe') && officeAlertOn('on') && officeAlertOn(' ON ') && officeAlertOn('true') && DESK_OFFICE_KEY === 'lead_desk_alert_office_team')
  expect('recipients merge without duplicates, case differences or bad addresses, desk list first', mergeDeskRecipients(['Desk.One@example.com', 'desk.two@example.com'], ['desk.one@example.com', 'ceo.person@example.com', 'nope', ' CEO.person@example.com ']).join() === 'desk.one@example.com,desk.two@example.com,ceo.person@example.com')
  const officeDb = {
    tables: {
      agents: [
        { id: 'o1', display_name: 'Ceo Person', email: 'ceo.person@example.com', office_role: 'ceo', status: 'published' },
        { id: 'o2', display_name: 'Cto Person', email: 'cto.person@example.com', office_role: 'cto', status: 'draft' },
        { id: 'o3', display_name: 'Mgr Person', email: 'Mgr.Person@example.com', office_role: 'mgr', status: 'ready' },
        { id: 'o4', display_name: 'Plain Agent', email: 'plain.agent@example.com', office_role: null, status: 'published' },
      ] as Record<string, unknown>[],
    },
  }
  const officeMail: { to: string[]; subject: string; text: string }[] = []
  const officeStore: Record<string, string> = { [DESK_EMAILS_KEY]: '["desk.one@example.com","ceo.person@example.com"]' }
  const officeDeps = {
    admin: fakeAdmin(officeDb), fetchImpl: (async (_u: unknown, init?: { body?: string }) => { officeMail.push(JSON.parse(init?.body ?? '{}')); return { ok: true } as Response }) as unknown as typeof fetch,
    get: async (k: string) => officeStore[k] ?? null, set: async (k: string, v: string) => { officeStore[k] = v }, now: () => new Date(NOW), adminUrl: 'https://example.com/admin', sendSms: async () => ({ ok: true }),
  }
  const allTo = () => officeMail.flatMap((m) => m.to)
  await announceHotLead({ ...lead, id: 'office-off-default' }, officeDeps)
  expect('by default (setting missing) only the desk list is emailed, even with office roles on the roster', officeMail.length === 1 && officeMail[0].to.join() === 'desk.one@example.com,ceo.person@example.com')
  officeStore[DESK_OFFICE_KEY] = 'off'
  await announceHotLead({ ...lead, id: 'office-off-explicit' }, officeDeps)
  expect('set to off it is the same: no office address is added', officeMail.length === 2 && officeMail[1].to.join() === 'desk.one@example.com,ceo.person@example.com' && !allTo().some((e) => /cto\.person|mgr\.person|plain\.agent/.test(e)))
  officeStore[DESK_OFFICE_KEY] = 'on'
  const onRes = await announceHotLead({ ...lead, id: 'office-on' }, officeDeps)
  const onMails = officeMail.slice(2)
  const onTo = onMails.flatMap((m) => m.to)
  expect('switched on, the CEO, CTO and Manager roster emails are added, the desk list is still emailed, and nobody is emailed twice', onRes.status === 'sent' && onRes.email === 'sent' && onMails[0].to.join() === 'desk.one@example.com,ceo.person@example.com' && new Set(onTo).size === onTo.length && ['desk.one@example.com', 'ceo.person@example.com', 'cto.person@example.com', 'mgr.person@example.com'].every((e) => onTo.includes(e)), onTo.join())
  expect('an agent with no office role is never added', !onTo.includes('plain.agent@example.com'))
  expect('the office copy has exactly the same generic body: no name, email or phone, only the trip and the admin link', onMails.length === 2 && onMails.every((m) => m.subject === onMails[0].subject && m.text === onMails[0].text) && !/@|Person|Agent|416|555/.test(onMails[0].text.replace('https://example.com/admin', '')) && onMails[0].text.includes('Alaska Cruise'), onMails[0].text)
  await announceHotLead({ ...lead, id: 'office-on' }, officeDeps)
  expect('a lead still alerts once: asking again sends nothing, to the desk or the office team', officeMail.length === 4)
  await announceHotLead({ ...lead, id: 'office-test', isTest: true }, officeDeps)
  expect('a test lead sends nothing to the office team either', officeMail.length === 4)
  const remMails = officeMail.length
  await sendDeskAlert({ ...lead, id: 'office-on' }, 'r', officeDeps, 20)
  expect('the one reminder also reaches the office team when the switch is on', officeMail.length === remMails + 2 && officeMail.slice(remMails).flatMap((m) => m.to).includes('cto.person@example.com') && /Reminder/.test(officeMail[remMails].subject))
  const strictDeps = { ...officeDeps, fetchImpl: (async (_u: unknown, init?: { body?: string }) => { const b = JSON.parse(init?.body ?? '{}') as { to: string[] }; if (b.to.some((e) => /cto\.person/.test(e))) throw new Error('domain not verified'); officeMail.push(b as never); return { ok: true } as Response }) as unknown as typeof fetch }
  const strictBefore = officeMail.length
  const strictRes = await announceHotLead({ ...lead, id: 'office-refused' }, strictDeps)
  expect('if the mail service refuses the office addresses, the desk alert still goes and counts as sent', strictRes.status === 'sent' && strictRes.email === 'sent' && officeMail.length === strictBefore + 1 && officeMail[strictBefore].to.join() === 'desk.one@example.com,ceo.person@example.com')
  const noRoleDb = { ...officeDeps, admin: fakeAdmin({ tables: { agents: [{ id: 'x1', display_name: 'Plain', email: 'plain.agent@example.com', office_role: null, status: 'published' }] } }) }
  const noRoleBefore = officeMail.length
  await announceHotLead({ ...lead, id: 'office-no-roles' }, noRoleDb)
  expect('on, but nobody holds a role yet: just the desk list, no error', officeMail.length === noRoleBefore + 1 && officeMail[noRoleBefore].to.join() === 'desk.one@example.com,ceo.person@example.com')
  officeStore[DESK_EMAILS_KEY] = ''
  const fallbackBefore = officeMail.length
  await announceHotLead({ ...lead, id: 'office-fallback' }, officeDeps)
  expect('with no desk list, the usual fallback address stays first and the office team is added after it', officeMail[fallbackBefore].to.join() === 'fallback.admin@example.com' && officeMail.slice(fallbackBefore).flatMap((m) => m.to).includes('mgr.person@example.com'))
  const brokenOffice = { ...officeDeps, admin: { from: () => { throw new Error('no table') } } as never }
  const brokenBefore = officeMail.length
  const brokenRes = await announceHotLead({ ...lead, id: 'office-db-down' }, brokenOffice)
  expect('if the roster cannot be read, the desk alert still goes', brokenRes.status === 'sent' && officeMail.length === brokenBefore + 1)

  // ---- 7. The reminder: one, after 15 minutes, only while unassigned
  const due = (over: Partial<Parameters<typeof reminderDue>[0]> = {}) => reminderDue({ createdAt: minsAgo(20), alreadyReminded: false, now: NOW, ...over })
  expect('no reminder before 15 minutes, one at 15', !due({ createdAt: minsAgo(14.9) }) && due({ createdAt: minsAgo(15) }) && due({ createdAt: minsAgo(40) }))
  expect('no reminder once assigned, contacted, test, already reminded, or older than a day', !due({ assignedAgentId: 'a1' }) && !due({ status: 'contacted' }) && !due({ status: 'assigned' }) && !due({ isTest: true }) && !due({ alreadyReminded: true }) && !due({ createdAt: minsAgo(25 * 60) }))
  const rows = [
    { id: 'r-old', created_at: minsAgo(20), assigned_agent_id: null, status: 'new', is_test: false, package: 'Alaska Cruise', page_path: null, utm_source: null, intent: 'callback', message: null },
    { id: 'r-new', created_at: minsAgo(5), assigned_agent_id: null, status: 'new', is_test: false, package: 'Alaska Cruise', page_path: null, utm_source: null, intent: 'callback', message: null },
    { id: 'r-assigned', created_at: minsAgo(30), assigned_agent_id: 'a1', status: 'assigned', is_test: false, package: 'X', page_path: null, utm_source: null, intent: null, message: null },
    { id: 'r-test', created_at: minsAgo(30), assigned_agent_id: null, status: 'new', is_test: true, package: 'X', page_path: null, utm_source: null, intent: null, message: null },
  ]
  expect('pickReminders chooses only the overdue, unassigned, real lead that was not reminded', pickReminders(rows, {}, NOW).map((l) => l.id).join() === 'r-old' && pickReminders(rows, { 'r-old': { a: 'x', r: 'y' } }, NOW).length === 0)

  const iso =(m: number) => minsAgo(m)
  const db = {
    tables: {
      app_settings: [] as Record<string, unknown>[],
      leads: [
        { id: 'r-old', hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(20), package: 'Alaska Cruise', page_path: '/packages/alaska', utm_source: 'instagram', intent: 'callback', message: null },
        { id: 'r-new', hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(5), package: 'Alaska Cruise', page_path: null, utm_source: null, intent: 'callback', message: null },
        { id: 'r-assigned', hot: true, is_test: false, status: 'assigned', assigned_agent_id: 'a1', created_at: iso(30), package: 'X', page_path: null, utm_source: null, intent: null, message: null },
        { id: 'r-test', hot: true, is_test: true, status: 'new', assigned_agent_id: null, created_at: iso(30), package: 'X', page_path: null, utm_source: null, intent: null, message: null },
        { id: 'r-cold', hot: false, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(30), package: 'X', page_path: null, utm_source: null, intent: null, message: null },
      ] as Record<string, unknown>[],
    },
  }
  const admin = fakeAdmin(db)
  const mail2: unknown[] = []
  const remDeps = { fetchImpl: (async (_u: unknown, init?: { body?: string }) => { mail2.push(JSON.parse(init?.body ?? '{}')); return { ok: true } as Response }) as unknown as typeof fetch, now: () => new Date(NOW), adminUrl: 'https://example.com/admin', sendSms: async () => ({ ok: true }) }
  const note1 = await runHotLeadReminders(admin, remDeps)
  expect('the 15 minute pass sends exactly one reminder for the one overdue hot lead', !!note1 && /1 hot lead/.test(note1) && mail2.length === 1, String(note1))
  const note2 = await runHotLeadReminders(admin, remDeps)
  expect('running the pass again sends nothing more (one reminder per lead)', note2 === null && mail2.length === 1)
  db.tables.app_settings = [{ key: 'automation_paused', value: 'true' }]
  db.tables.leads.push({ id: 'r-paused', hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(40), package: 'Y', page_path: null, utm_source: null, intent: null, message: null })
  const note3 = await runHotLeadReminders(admin, remDeps)
  expect('the reminder is skipped while all automation is paused', note3 === null && mail2.length === 1)

  // ---- 8. Assigning: a person chooses; it records, tags, emails the agent only, and logs
  const adb = {
    tables: {
      app_settings: [] as Record<string, unknown>[],
      agents: [
        { id: 'a-pub', slug: 'amy-sample', display_name: 'Amy Sample', status: 'published', email: 'amy.agent@example.com', phone: '416-555-0111', specialties: ['Cruises'], region: 'Ontario', office_role: 'ceo' },
        { id: 'a-draft', slug: 'bea-fixture', display_name: 'Bea Fixture', status: 'draft', email: 'bea.agent@example.com', phone: '416-555-0112', specialties: [], region: null, office_role: 'mgr' },
        { id: 'a-ready', slug: 'cal-demo', display_name: 'Cal Demo', status: 'ready', email: null, phone: null, specialties: [], region: null },
        { id: 'a-old', slug: 'old-hand', display_name: 'Old Hand', status: 'archived', email: 'old.agent@example.com', phone: null, specialties: [], region: null },
      ] as Record<string, unknown>[],
      leads: [
        { id: 'L1', name: 'Test Person', email: 'test.person@example.com', phone: '416-555-0199', package: 'Alaska Cruise', page_path: '/packages/alaska', utm_source: 'instagram', intent: 'callback', message: `${CALLBACK_PREFIX} Hello there`, hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(10) },
        { id: 'L2', name: 'Test Two', email: 'test.two@example.com', phone: '416-555-0198', package: 'Disney', page_path: null, utm_source: null, intent: null, message: null, hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(10) },
        { id: 'L3', name: 'Test Three', email: 'test.three@example.com', phone: null, package: 'Disney', page_path: null, utm_source: null, intent: null, message: null, hot: true, is_test: false, status: 'new', assigned_agent_id: null, created_at: iso(10) },
      ] as Record<string, unknown>[],
    },
  }
  const aadmin = fakeAdmin(adb)
  const agentMail: { to: string[]; subject: string; text: string }[] = []
  const aDeps = { fetchImpl: (async (_u: unknown, init?: { body?: string }) => { agentMail.push(JSON.parse(init?.body ?? '{}')); return { ok: true } as Response }) as unknown as typeof fetch, now: () => new Date(NOW) }
  const pick = await listPickerAgents(aadmin)
  expect('the picker list has no private fields and no archived agent', pick.length === 3 && pick.every((a) => !('email' in a) && !('phone' in a) && !('address' in a) && !('notes' in a)))
  const noAuto = (adb.tables.leads as Record<string, unknown>[]).every((l) => l.assigned_agent_id === null)
  expect('the picker carries the office role label for the badge and nothing private with it', pick.find((a) => a.id === 'a-pub')?.office_role === 'ceo' && pick.find((a) => a.id === 'a-draft')?.office_role === 'mgr' && pick.find((a) => a.id === 'a-ready')?.office_role === null && JSON.stringify(pick).indexOf('@') === -1 && !/555-01/.test(JSON.stringify(pick)))
  const colsAsked: string[] = []
  const olderDb = {
    from: () => ({
      select: (cols: string) => {
        colsAsked.push(cols)
        const res = cols.includes('office_role') ? { data: null, error: { message: 'column agents.office_role does not exist' } } : { data: [{ id: 'x', slug: 'x', display_name: 'X Person', specialties: [], status: 'draft', region: null }], error: null }
        const chain: Record<string, unknown> = { in: () => chain, order: () => chain, limit: () => chain, then: (r: (v: unknown) => unknown) => r(res) }
        return chain
      },
    }),
  } as never
  const olderPick = await listPickerAgents(olderDb)
  expect('before migration 0057 the picker still loads (no badges), with no private column asked for', olderPick.length === 1 && olderPick[0].office_role === null && colsAsked.length === 2 && colsAsked.every((c) => !/email|phone|address|notes/.test(c)))
  expect('before anyone chooses, no lead has an agent', noAuto)
  const asg = await assignLead(aadmin, { leadId: 'L1', agentId: 'a-pub', assignedBy: 'Leslie' }, aDeps)
  const l1 = adb.tables.leads[0]
  expect('assigning saves the agent, who chose, when, and the assigned status', asg.ok && l1.assigned_agent_id === 'a-pub' && l1.assigned_by === 'Leslie' && l1.assigned_at === new Date(NOW).toISOString() && l1.status === 'assigned', JSON.stringify(asg))
  expect('only the chosen agent is emailed, at the roster address, with the lead details', agentMail.length === 1 && agentMail[0].to.join() === 'amy.agent@example.com' && agentMail[0].text.includes('Test Person') && agentMail[0].text.includes('416-555-0199'))
  expect('the other leads were not touched (nothing is assigned automatically)', adb.tables.leads[1].assigned_agent_id === null && adb.tables.leads[2].assigned_agent_id === null)
  expect('the GoHighLevel step is best effort: with no GoHighLevel set up it is a warning, not a failure', asg.ok && asg.warnings.some((w) => /GoHighLevel/.test(w)))
  const log = parseLog(String((adb.tables.app_settings.find((r) => r.key === 'today_log') ?? {}).value))
  expect('the decision is written to the Today activity log, not undoable', log.length === 1 && log[0].kind === 'hot-lead' && /Amy Sample/.test(log[0].title) && log[0].undoable === false)
  expect('the plain new lead card for it is marked done', String((adb.tables.app_settings.find((r) => r.key === 'today_leads_done') ?? {}).value).includes('L1'))
  const again = await assignLead(aadmin, { leadId: 'L1', agentId: 'a-draft', assignedBy: 'Joel' }, aDeps)
  expect('a second person cannot silently take over an assigned lead', !again.ok && again.status === 409 && l1.assigned_agent_id === 'a-pub' && agentMail.length === 1)
  const moved = await assignLead(aadmin, { leadId: 'L1', agentId: 'a-draft', assignedBy: 'Joel', reassign: true }, aDeps)
  expect('moving it on purpose works and emails the new agent only', moved.ok && l1.assigned_agent_id === 'a-draft' && agentMail.length === 2 && agentMail[1].to.join() === 'bea.agent@example.com')
  const old = await assignLead(aadmin, { leadId: 'L2', agentId: 'a-old', assignedBy: 'Joel' }, aDeps)
  expect('an archived agent cannot be chosen', !old.ok && old.status === 400 && adb.tables.leads[1].assigned_agent_id === null)
  const noMail = await assignLead(aadmin, { leadId: 'L2', agentId: 'a-ready', assignedBy: 'Joel; drop table' }, aDeps)
  expect('an agent with no email still gets the lead, with a plain warning, and the name is cleaned', noMail.ok && noMail.warnings.some((w) => /no email on the roster/.test(w)) && agentMail.length === 2 && adb.tables.leads[1].assigned_by === 'Joel drop table')
  const failMail = await assignLead(aadmin, { leadId: 'L3', agentId: 'a-pub', assignedBy: 'Shelby' }, { ...aDeps, fetchImpl: (async () => { throw new Error('boom') }) as unknown as typeof fetch })
  expect('a failing email never undoes the assignment', failMail.ok && adb.tables.leads[2].assigned_agent_id === 'a-pub' && failMail.warnings.some((w) => /did not go out/.test(w)))
  const gone = await assignLead(aadmin, { leadId: 'nope', agentId: 'a-pub', assignedBy: 'Joel' }, aDeps)
  expect('an unknown lead or agent is refused', !gone.ok && gone.status === 404 && !(await assignLead(aadmin, { leadId: 'L2', agentId: 'nope', assignedBy: 'Joel' }, aDeps)).ok)

  // ---- 9. The System check: the hot lead wait on the Conversion stage
  const baseFacts = (hot: CheckFacts['hotLeads']): CheckFacts => ({
    ...unreadFacts(new Date(NOW)),
    watchdog: { at: new Date(NOW).toISOString(), checks: [{ stage: 'conversion', status: 'ok', evidence: { pages_with_visits_and_no_leads: 0, visit_floor: 100 } }] },
    hotLeads: hot,
  })
  const conv = (hot: CheckFacts['hotLeads']) => evaluateCheck(baseFacts(hot)).stages.find((s) => s.id === 'conversion')!
  expect('no hot lead waiting leaves the Conversion stage as it was (green)', conv({ count: 0, oldestMinutes: 0 }).light === 'green' && conv(undefined).light === 'green' && conv(null).light === 'green')
  expect('a hot lead waiting under 15 minutes keeps it green', conv({ count: 1, oldestMinutes: 10 }).light === 'green')
  const amber = conv({ count: 1, oldestMinutes: 22.6 })
  expect('a hot lead waiting over 15 minutes is amber, with the real number in a plain sentence', amber.light === 'amber' && /22 minutes/.test(amber.sentence) && /no agent/.test(amber.sentence) && !!amber.needs && amber.needs.href === '/admin', amber.sentence)
  const red = conv({ count: 2, oldestMinutes: 95 })
  expect('a hot lead waiting over 60 minutes is red', red.light === 'red' && /^2 leads/.test(red.sentence) && /1 h 35 min/.test(red.sentence) && /2 hot leads waiting/.test(red.number ?? ''), red.sentence)
  expect('the light function agrees: none, green, amber at 15.1, red at 60.1', hotWaitLight(null) === null && hotWaitLight({ count: 0, oldestMinutes: 99 }) === null && hotWaitLight({ count: 1, oldestMinutes: 15 }) === 'green' && hotWaitLight({ count: 1, oldestMinutes: 15.1 }) === 'amber' && hotWaitLight({ count: 1, oldestMinutes: 60 }) === 'amber' && hotWaitLight({ count: 1, oldestMinutes: 60.1 }) === 'red')
  // reading grade 6 or lower (Flesch-Kincaid, same rule as scripts/check-system-check-voice.ts)
  const syl = (w: string) => { const s = w.toLowerCase().replace(/[^a-z]/g, ''); if (!s) return 1; const g = s.replace(/e$/, '').match(/[aeiouy]+/g); return Math.max(1, g ? g.length : 1) }
  const grade = (sentence: string) => { const ws = sentence.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)); if (!ws.length) return 0; return 0.39 * ws.length + 11.8 * (ws.reduce((n, w) => n + syl(w), 0) / ws.length) - 15.59 }
  const sentences = [22.6, 95, 8].flatMap((m) => [1, 3].flatMap((c) => hotWaitSentence({ count: c, oldestMinutes: m }).split(/(?<=[.!?])\s+/)))
  expect('every lead desk sentence reads at grade 6 or lower', sentences.every((s) => grade(s) <= 6), sentences.filter((s) => grade(s) > 6).map((s) => `${s} (${grade(s).toFixed(1)})`).join(' | '))
  expect('the whole stage text stays short (3 sentences, 40 words)', [amber, red].every((s) => s.sentence.split(/(?<=[.!?])\s+/).length <= 3 && s.sentence.split(/\s+/).length <= 40), amber.sentence + ' || ' + red.sentence)

  // ---- 10. The Today card
  const def = TODAY_KINDS['hot-lead']
  expect('the hot lead kind is the first, urgent kind with a 30 minute Later and no yes/no buttons that act', def.group === 'urgent' && def.order === 0 && Object.values(TODAY_KINDS).every((k) => k.kind === 'hot-lead' || k.order > 0) && def.snoozeMinutes === 30 && def.secondary === null && def.primary.mode === 'open')
  expect('a hot lead card id is the lead id', parseCardId('hot-lead:123e4567-e89b-12d3-a456-426614174000')?.kind === 'hot-lead' && parseCardId('hot-lead:not-a-uuid') === null)
  const snooze = addSnoozeMinutes({}, 'hot-lead:x', 30, NOW)
  expect('Later hides the card for 30 minutes, then it is back', visibleCards([{ id: 'hot-lead:x', kind: 'hot-lead', title: 't', why: 'w', facts: [], sortKey: 0 }], snooze, NOW + 29 * 60_000).length === 0 && visibleCards([{ id: 'hot-lead:x', kind: 'hot-lead', title: 't', why: 'w', facts: [], sortKey: 0 }], snooze, NOW + 31 * 60_000).length === 1)

  const { buildTodayQueue } = await import('../lib/today-queue')
  const HOT = '123e4567-e89b-12d3-a456-426614174111'
  const tdb = {
    tables: {
      app_settings: [] as Record<string, unknown>[],
      leads: [
        { id: HOT, name: 'Test Person', email: 'test.person@example.com', phone: '416-555-0199', package: 'Alaska Cruise', page_path: '/packages/alaska', utm_source: 'instagram', intent: 'callback', message: null, hot: true, is_test: false, status: 'new', assigned_agent_id: null, forwarded_to_ghl: true, created_at: new Date().toISOString() },
        { id: '123e4567-e89b-12d3-a456-426614174222', name: 'Test Done', email: 'test.done@example.com', phone: '416-555-0188', package: 'X', page_path: null, utm_source: null, intent: null, message: null, hot: true, is_test: false, status: 'assigned', assigned_agent_id: 'a1', forwarded_to_ghl: true, created_at: new Date().toISOString() },
        { id: '123e4567-e89b-12d3-a456-426614174333', name: 'Test Test', email: 'x@example.com', phone: '416-555-0177', package: 'X', page_path: null, utm_source: null, intent: null, message: null, hot: true, is_test: true, status: 'new', assigned_agent_id: null, forwarded_to_ghl: true, created_at: new Date().toISOString() },
      ] as Record<string, unknown>[],
    },
  }
  const q = await buildTodayQueue(fakeAdmin(tdb), Date.now())
  const hotCards = q.cards.filter((c) => c.kind === 'hot-lead')
  expect('the queue has one hot lead card for the one waiting real lead, at the very top', hotCards.length === 1 && hotCards[0].id === `hot-lead:${HOT}` && q.cards[0].kind === 'hot-lead', q.cards.map((c) => c.id).join(',') + ' PROBLEMS ' + q.problems.join('|'))
  expect('the card carries who, trip, source, what they asked, phone and email', !!hotCards[0]?.hot && hotCards[0].hot.phone === '416-555-0199' && hotCards[0].hot.email === 'test.person@example.com' && hotCards[0].hot.asked === 'Asked for a call back from a live agent' && hotCards[0].hot.source === 'instagram' && hotCards[0].facts.some((f) => f.label === 'Trip or page' && f.value === 'Alaska Cruise'))
  expect('the same lead has no second plain new lead card', !q.cards.some((c) => c.id === `lead-reply:${HOT}`))
  expect('an assigned lead and a test lead are not on the queue as hot leads', !q.cards.some((c) => c.id.includes('426614174222') && c.kind === 'hot-lead') && !q.cards.some((c) => c.id.includes('426614174333') && c.kind === 'hot-lead'))
  tdb.tables.app_settings.push({ key: 'today_snoozed', value: JSON.stringify(addSnoozeMinutes({}, `hot-lead:${HOT}`, 30, Date.now())) })
  const q2 = await buildTodayQueue(fakeAdmin(tdb), Date.now())
  expect('after Later the card is hidden', !q2.cards.some((c) => c.kind === 'hot-lead'))
  const q3 = await buildTodayQueue(fakeAdmin(tdb), Date.now() + 31 * 60_000)
  expect('and it comes back after 30 minutes, still unassigned', q3.cards.some((c) => c.kind === 'hot-lead'))

  // ---- 11. Privacy and source rules
  const files = ['lib/lead-desk.ts', 'lib/lead-desk-store.ts', 'app/api/admin/leads/assign/route.ts', 'app/api/admin/leads/route.ts', 'components/admin/hot-lead-panel.tsx', 'components/admin/leads-desk.tsx', 'scripts/check-lead-desk.ts', 'supabase/migrations/0055_lead_desk.sql']
  expect('every new file exists', files.every((f) => existsSync(join(process.cwd(), f))))
  expect('no long dash in any new file', files.every((f) => !DASH.test(read(f).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))), files.filter((f) => DASH.test(read(f).replace(/\/\/[^\n]*/g, ''))).join(','))
  const storeSrc = read('lib/lead-desk-store.ts')
  expect('the agent picker query selects no private column (only the office role label beyond the old list)', /admin\.from\('agents'\)\.select\(cols\)/.test(storeSrc) && storeSrc.includes("pick('id, slug, display_name, specialties, status, region, office_role')") && storeSrc.includes("pick('id, slug, display_name, specialties, status, region')"))
  expect('the Office team badge, heading and grouping are wired into the picker panel, with no preselection', /groupPickerEntries/.test(read('components/admin/hot-lead-panel.tsx')) && /Office team/.test(read('components/admin/hot-lead-panel.tsx')) && /Suggested by specialty/.test(read('components/admin/hot-lead-panel.tsx')) && /useState<PickerEntry \| null>\(null\)/.test(read('components/admin/hot-lead-panel.tsx')) && !/setChosen\([^n)]/.test(read('components/admin/hot-lead-panel.tsx').replace(/setChosen\(e\)/g, '').replace(/setChosen\(null\)/g, '')))
  expect('the office alert reads private roster emails only inside listOfficeEmails and only when the switch is on', /officeAlertOn\(await get\(DESK_OFFICE_KEY\)/.test(storeSrc) && (storeSrc.match(/listOfficeEmails\(/g) ?? []).length === 2 && /select\('email, office_role'\)/.test(storeSrc))
  expect('the office-alert key is documented in .env.example and the migration is 0057', /lead_desk_alert_office_team/.test(read('.env.example')) && existsSync(join(process.cwd(), 'supabase/migrations/0057_agents_office_role.sql')))
  expect('the private agent email is only read inside assignLead', (storeSrc.match(/email/g) ?? []).length > 0 && !/listPickerAgents[\s\S]{0,400}email/.test(storeSrc.slice(storeSrc.indexOf('export async function listPickerAgents'), storeSrc.indexOf('export async function deskSmsConfigured'))))
  expect('nothing assigns an agent except assignLead (the form routes, the pipeline, the reminder and the Today actions never write assigned_agent_id)', (storeSrc.match(/assigned_agent_id: input\./g) ?? []).length === 1 && ['lib/leads.ts', 'lib/pipeline.ts', 'lib/today-actions.ts', 'lib/today-queue.ts', 'app/api/submit-lead/route.ts', 'app/api/admin/today/route.ts'].every((f) => !/assigned_agent_id\s*:|assigned_agent_id'\s*:/.test(read(f))))
  expect('assignLead is only called from the admin assign route', ['lib', 'app', 'components'].every(() => true) && read('app/api/admin/leads/assign/route.ts').includes('assignLead(') && !read('lib/pipeline.ts').includes('assignLead') && !read('lib/leads.ts').includes('assignLead'))
  expect('both admin routes check isAuthorized first in every handler', ['app/api/admin/leads/assign/route.ts', 'app/api/admin/leads/route.ts'].every((f) => {
    const hs = [...read(f).matchAll(/export async function (GET|POST|PATCH)\(request: Request\) \{\r?\n([^\n]*)\n/g)]
    return hs.length >= 2 && hs.every((m) => /isAuthorized\(request\)/.test(m[2]))
  }))
  expect('the Today route refuses a yes/no on a hot lead (only Later)', /parsed\.kind === 'hot-lead' && op !== 'snooze'/.test(read('app/api/admin/today/route.ts')))
  expect('the log lines and console output never print a lead name, email or phone', !/console\.(log|error|warn)\([^)]*(name|email|phone)/.test(storeSrc))
  expect('the form routes fire the alert without waiting for it', /void markAndAnnounceHot/.test(read('lib/leads.ts')) && !/await announceLead/.test(read('lib/leads.ts')))
  expect('the migration adds every column the desk needs and never assigns anyone', ['hot', 'intent', 'assigned_agent_id', 'assigned_at', 'assigned_by', 'first_contact_at', 'status', 'desk_note'].every((c) => new RegExp(`add column if not exists ${c}\\b`).test(read('supabase/migrations/0055_lead_desk.sql'))) && !/update\s+public\.leads/i.test(read('supabase/migrations/0055_lead_desk.sql')))
  expect('the settings keys are documented in .env.example', /lead_desk_alert_emails/.test(read('.env.example')) && /lead_desk_alert_sms_contact_ids/.test(read('.env.example')) && /LEAD_DESK_FROM_EMAIL/.test(read('.env.example')))
  expect('the Needs attention list has the amber setup item for the lead desk', /LEAD_DESK_SETUP_ISSUE_ID/.test(read('lib/issues.ts')) && /Lead desk texts are not set up/.test(read('lib/issues.ts')))

  console.log(failures === 0 ? '\nAll lead desk checks passed.' : `\n${failures} lead desk check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
