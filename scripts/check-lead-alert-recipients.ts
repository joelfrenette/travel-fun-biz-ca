// Offline check: the lead alert recipients card (validation, dedupe, the stored format, the route guards).
// Run: pnpm dlx tsx scripts/check-lead-alert-recipients.ts   (exit 1 on a failure)
// Every name and address below is made up (example.com).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESK_EMAILS_KEY, parseDeskEmails } from '../lib/lead-desk'
import { DESK_NAMES_KEY, buildRecipientRows, cleanName, parseDeskNames, serializeRecipients, validateRecipients } from '../lib/lead-alert-recipients'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DASH = new RegExp('[' + String.fromCharCode(0x2014) + String.fromCharCode(0x2013) + ']')

const good = validateRecipients([{ name: ' Joel ', email: 'Joel.Desk@Example.com ' }, { name: 'Shelby', email: 'shelby.desk@example.com' }, { name: 'Leslie', email: '' }])
expect('valid rows pass, addresses are lower-cased, blank rows are skipped', good.ok && good.rows.length === 2 && good.rows[0].email === 'joel.desk@example.com' && good.rows[0].name === 'Joel')
const bad = validateRecipients([{ name: 'A', email: 'nope' }])
expect('an invalid address is rejected with a clear message', !bad.ok && /not a valid email/.test(bad.error))
expect('header injection characters are rejected', !validateRecipients([{ email: 'a@example.com,b@example.com' }]).ok && !validateRecipients([{ email: 'a@example.com\r\nbcc:x@example.com' }]).ok)
const dup = validateRecipients([{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'A@example.com' }])
expect('a duplicate address is rejected, not silently dropped', !dup.ok && /twice/.test(dup.error))
const many = Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.com` }))
expect('more than 10 addresses is rejected, exactly 10 is fine', !validateRecipients(many).ok && validateRecipients(many.slice(0, 10)).ok)
expect('a non-list body is rejected and an empty list is allowed (clears the alerts)', !validateRecipients('x').ok && !validateRecipients(null).ok && validateRecipients([]).ok)

const ser = serializeRecipients(good.ok ? good.rows : [])
expect('the email setting keeps its format: a JSON list of addresses the lead desk parses back unchanged', ser.emails === '["joel.desk@example.com","shelby.desk@example.com"]' && parseDeskEmails(ser.emails).join() === 'joel.desk@example.com,shelby.desk@example.com')
expect('the names are a separate JSON map of email to label', JSON.parse(ser.names)['joel.desk@example.com'] === 'Joel' && (DESK_NAMES_KEY as string) !== (DESK_EMAILS_KEY as string) &&DESK_NAMES_KEY === 'lead_desk_alert_names' && DESK_EMAILS_KEY === 'lead_desk_alert_emails')
const rows = buildRecipientRows(ser.emails, ser.names)
expect('rows rebuild from the two settings', rows.length === 2 && rows[1].name === 'Shelby')
expect('an address with no stored name still shows, with a blank label', buildRecipientRows('["x.person@example.com"]', null)[0].name === '' && buildRecipientRows('a@example.com, b@example.com', '').length === 2)
expect('unreadable or odd stored names give an empty map, never a throw', Object.keys(parseDeskNames('not json')).length === 0 && Object.keys(parseDeskNames('["a"]')).length === 0 && Object.keys(parseDeskNames(null)).length === 0)
expect('names are one line and capped', cleanName('a\r\nb') === 'a b' && cleanName('x'.repeat(100)).length === 40 && cleanName(5) === '')

const route = read('app/api/admin/lead-alert-recipients/route.ts')
const hs = [...route.matchAll(/export async function (GET|POST)\(request: Request\) \{\r?\n([^\n]*)\n/g)]
expect('GET and POST both check isAuthorized first', hs.length === 2 && hs.every((m) => /isAuthorized\(request\)/.test(m[2])))
expect('the route saves through setSetting under both keys and uses the service role client', /setSetting\(admin, DESK_NAMES_KEY/.test(route) && /setSetting\(admin, DESK_EMAILS_KEY/.test(route) && /getSupabaseAdmin\(\)/.test(route))
expect('the card is on the Agents panel and the names key is documented', /<LeadAlertRecipientsCard \/>/.test(read('components/admin/agents-panel.tsx')) && /lead_desk_alert_names/.test(read('.env.example')))
expect('no em or en dashes in the new files', ['lib/lead-alert-recipients.ts', 'app/api/admin/lead-alert-recipients/route.ts', 'components/admin/lead-alert-recipients-card.tsx'].every((f) => !DASH.test(read(f))))

console.log(failures === 0 ? '\nAll lead alert recipient checks passed.' : `\n${failures} lead alert recipient check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
