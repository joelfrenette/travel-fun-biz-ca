// Offline check: the main contact form (optional package, plain error messages).
// Run: pnpm dlx tsx scripts/check-contact-form.ts   (exit 1 on a failure)
import { contactFormSchema, contactSubmissionSchema } from '../lib/schemas/contact'
import { formErrorMessage, submitPackage } from '../lib/form-errors'
import { site } from '../lib/site'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else { failures++; console.log(`FAIL ${name} ${detail}`) }
}

const base = { name: 'Test Visitor', email: 'test@example.com' }

expect('schema accepts no package', contactFormSchema.safeParse(base).success)
expect('schema accepts empty package', contactFormSchema.safeParse({ ...base, package: '' }).success)
expect('schema accepts a chosen package', contactFormSchema.safeParse({ ...base, package: 'Aruba Escape' }).success)
expect('submission schema accepts no package', contactSubmissionSchema.safeParse(base).success)
expect('schema rejects missing email', !contactFormSchema.safeParse({ name: 'Test Visitor' }).success)
expect('schema rejects bad email', !contactFormSchema.safeParse({ ...base, email: 'nope' }).success)
expect('schema rejects missing name', !contactFormSchema.safeParse({ email: 'test@example.com' }).success)
expect('schema rejects blank name', !contactFormSchema.safeParse({ ...base, name: '   ' }).success)

expect('empty package becomes Custom Package', submitPackage('') === 'Custom Package')
expect('undefined package becomes Custom Package', submitPackage(undefined) === 'Custom Package')
expect('blank package becomes Custom Package', submitPackage('   ') === 'Custom Package')
expect('chosen package is kept', submitPackage('Aruba Escape') === 'Aruba Escape')
expect('payload with the fallback still passes the API schema', contactSubmissionSchema.safeParse({ ...base, package: submitPackage('') }).success)

const m429 = formErrorMessage(429, site.phone)
const mNet = formErrorMessage(null, site.phone)
const m500 = formErrorMessage(500, site.phone)
const m400 = formErrorMessage(400, site.phone)
expect('429 message is distinct', m429 !== mNet && m429 !== m500 && m429 !== m400)
expect('network message is distinct', mNet !== m500 && mNet !== m400)
expect('other-status message is not the old generic one', m500 !== 'Something went wrong. Please try again.')
expect('429 message contains site.phone', !!site.phone && m429.includes(site.phone))
expect('network message contains site.phone', !!site.phone && mNet.includes(site.phone))
expect('no phone given still gives a message without a dangling call line', !formErrorMessage(429).includes('call or text'))
expect('no em dashes in messages', ![m429, mNet, m500, m400].some((m) => m.includes('—')))

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll contact form checks passed')
