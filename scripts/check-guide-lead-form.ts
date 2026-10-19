// Offline check: the inline lead form on guide pages.
// Behavioural on the pure payload/message helpers (validated against the schema /api/submit-lead uses), plus a render
// of the sticky bar, plus wiring checks for the mount and the #guide-cta anchors.
// Run: pnpm dlx tsx scripts/check-guide-lead-form.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { createElement } from 'react'
;(globalThis as { React?: unknown }).React = React
import { renderToStaticMarkup } from 'react-dom/server'
import { contactSubmissionSchema } from '../lib/schemas/contact'
import { isHoneypotFilled } from '../lib/abuse-guard'
import { site } from '../lib/site'
import { enquiryHref } from '../lib/guide-facts'
import { StickyCta } from '../components/sticky-cta'
import {
  buildGuideLeadPayload,
  guideFormPackage,
  guideFormMissing,
  classifyGuideFormFailure,
  guideFormMessage,
} from '../lib/guide-lead-form'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// 1. Payload shape, validated by the schema the route uses.
const attribution = { utm_source: 'instagram', page_path: '/destinations/aruba' }
const full = buildGuideLeadPayload({ name: ' Pat ', email: ' pat@example.com ', phone: ' 555 0100 ', message: ' Two adults ', packageName: 'Aruba Escape', attribution, submittedAt: '2026-10-19T10:00:00.000Z' })
const parsedFull = contactSubmissionSchema.safeParse(full)
expect('full payload passes the submit-lead schema', parsedFull.success, JSON.stringify(parsedFull.success ? '' : parsedFull.error.flatten()))
expect('values are trimmed', full.name === 'Pat' && full.email === 'pat@example.com' && full.phone === '555 0100' && full.message === 'Two adults')
expect('package is the linked trip name', full.package === 'Aruba Escape')
expect('attribution is carried through', full.attribution?.utm_source === 'instagram' && full.attribution?.page_path === '/destinations/aruba')

// 2. Minimal payload: only name and email.
const minimal = buildGuideLeadPayload({ name: 'Pat', email: 'pat@example.com' })
expect('name + email only passes the schema', contactSubmissionSchema.safeParse(minimal).success)
expect('empty optional fields are left out, not sent blank', !('phone' in minimal) && !('message' in minimal))
expect('blank phone and message are left out', (() => { const p = buildGuideLeadPayload({ name: 'a', email: 'a@b.co', phone: '  ', message: '' }); return !('phone' in p) && !('message' in p) })())
expect('required fields are name and email only', guideFormMissing({ name: '', email: '' }).join() === 'name,email' && guideFormMissing({ name: 'a', email: '' }).join() === 'email' && guideFormMissing({ name: '', email: 'a@b.co' }).join() === 'name' && guideFormMissing({ name: 'a', email: 'a@b.co' }).length === 0)
expect('a bad email is rejected by the schema', !contactSubmissionSchema.safeParse(buildGuideLeadPayload({ name: 'Pat', email: 'nope' })).success)

// 3. Package fallback.
for (const none of [undefined, null, '', '   ']) {
  expect(`package falls back to Custom Package for ${JSON.stringify(none)}`, guideFormPackage(none) === 'Custom Package' && buildGuideLeadPayload({ name: 'a', email: 'a@b.co', packageName: none }).package === 'Custom Package')
}
expect('package whitespace is collapsed', guideFormPackage('  Aruba   Escape ') === 'Aruba Escape')

// 4. Honeypot is empty for a real visitor and the route would not treat it as a bot.
expect('honeypot field is empty by default', minimal.company_website === '' && full.company_website === '')
expect('route honeypot test does not trip on the payload', !isHoneypotFilled(full) && !isHoneypotFilled(minimal))
expect('a filled honeypot is still carried so the route can drop the bot', isHoneypotFilled(buildGuideLeadPayload({ name: 'a', email: 'a@b.co', honeypot: 'spam.example' })))

// 5. Failure messages: 429 and network are distinct, both offer site.phone, neither uses an em dash.
expect('429 maps to rate_limited', classifyGuideFormFailure(429) === 'rate_limited')
expect('no response maps to network', classifyGuideFormFailure(null) === 'network')
expect('400 maps to invalid, 500 and 502 to server', classifyGuideFormFailure(400) === 'invalid' && classifyGuideFormFailure(500) === 'server' && classifyGuideFormFailure(502) === 'server')
const m429 = guideFormMessage('rate_limited', site.phone)
const mNet = guideFormMessage('network', site.phone)
expect('429 and network messages differ', m429 !== mNet && m429.length > 0 && mNet.length > 0)
expect('429 message says wait, network message says connection', /wait/i.test(m429) && /connection/i.test(mNet) && !/connection/i.test(m429))
expect('both messages offer the site phone', m429.includes(site.phone) && mNet.includes(site.phone))
expect('with no site phone the call line is left out', !guideFormMessage('network', '').includes('call') && !guideFormMessage('network', null).includes('undefined'))
expect('no em dashes in messages', ![m429, mNet, guideFormMessage('invalid'), guideFormMessage('server', site.phone)].some((s) => s.includes('—')))

// 6. The sticky bar renders a #guide-cta request link when given it; the enquiry link remains available as the fallback.
const bar = renderToStaticMarkup(createElement(StickyCta, { packageName: 'Aruba', requestLabel: 'Request Info', requestHref: '#guide-cta', phone: site.phone }))
expect('sticky bar request button points at #guide-cta', bar.includes('href="#guide-cta"'))
expect('old enquiry link still builds (no-JS fallback)', enquiryHref('Aruba Escape') === '/?package=Aruba%20Escape#contact')

// 7. Wiring: the form is mounted in the #guide-cta section, the anchors are set, and the enquiry link stays.
const cta = read('components/guide-cta.tsx')
const sectionStart = cta.indexOf('<section id="guide-cta"')
expect('GuideCta imports and mounts GuideLeadForm inside the #guide-cta section', sectionStart > 0 && cta.indexOf('<GuideLeadForm', sectionStart) > sectionStart && /packageName=\{packageName\}/.test(cta.slice(cta.indexOf('<GuideLeadForm'))))
expect('GuideCta keeps the enquiry link as the no-JS fallback', cta.indexOf('<Link href={enquiry}', sectionStart) > sectionStart)
const page = read('components/guide-page.tsx')
expect('guide page sticky bar href is #guide-cta', /<StickyCta[\s\S]*?requestHref="#guide-cta"/.test(page))
expect('guide page header actions get the #guide-cta anchor', /<GuideHeaderActions[^>]*formAnchor="#guide-cta"/.test(page))
const actions = read('components/guide-header-actions.tsx')
expect('header actions use the anchor and keep the enquiry link fallback', actions.includes('formAnchor || cta.enquiryHref'))
const form = read('components/guide-lead-form.tsx')
expect('form posts to the existing /api/submit-lead and routes to /thank-you', form.includes('"/api/submit-lead"') && form.includes('/thank-you'))
expect('form names the honeypot company_website', form.includes('name="company_website"'))

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll guide lead form checks passed')
