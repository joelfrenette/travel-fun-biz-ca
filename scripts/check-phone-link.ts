// Offline check: one-tap call or text with click tracking (growth loop: lead capture). Renders the real components
// and fires the real click handler with a stubbed gtag; no network, no database.
// Run: pnpm dlx tsx scripts/check-phone-link.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import { createElement, isValidElement, type ReactElement } from 'react'
import { PhoneLink, phoneEventName } from '../components/phone-link'
import { StickyCta } from '../components/sticky-cta'
import { translate } from '../lib/i18n'
import { site } from '../lib/site'

const DASH = String.fromCharCode(8212)
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

// tsx compiles JSX with the classic runtime here, so the components expect a global React.
;(globalThis as unknown as { React: unknown }).React = React

// Stub window + gtag so track() records what it sends.
const sent: Array<{ name: string; params: Record<string, unknown> }> = []
;(globalThis as unknown as { window: unknown }).window = {
  location: { pathname: '/destinations/aruba' },
  gtag: (_c: string, name: string, params: Record<string, unknown>) => sent.push({ name, params }),
}

// 1. PhoneLink renders nothing for an empty address and an anchor otherwise.
expect('PhoneLink renders nothing for an empty href', renderToStaticMarkup(createElement(PhoneLink, { href: '', method: 't', children: 'x' })) === '')
expect('PhoneLink renders nothing for a blank href', renderToStaticMarkup(createElement(PhoneLink, { href: '   ', method: 't', children: 'x' })) === '')
expect('PhoneLink renders nothing for an undefined href', renderToStaticMarkup(createElement(PhoneLink, { href: undefined, method: 't', children: 'x' })) === '')
const html = renderToStaticMarkup(createElement(PhoneLink, { href: 'tel:+18338785386', method: 'guide_cta', children: 'Call' }))
expect('PhoneLink draws a tel anchor', html.includes('href="tel:+18338785386"') && html.includes('>Call<'), html)

// 2. The click handler fires the right event with page_path and method.
function click(href: string, method: string) {
  const el = PhoneLink({ href, method, children: 'x' }) as ReactElement<{ onClick: () => void }>
  expect('PhoneLink returns an element for ' + href, isValidElement(el))
  el.props.onClick()
}
click('tel:+18338785386', 'sticky_bar')
click('sms:+18338785386', 'thank_you')
expect('tel tap sends phone_click', sent[0]?.name === 'phone_click', JSON.stringify(sent))
expect('tel tap carries page_path and method', sent[0]?.params.page_path === '/destinations/aruba' && sent[0]?.params.method === 'sticky_bar')
expect('sms tap sends sms_click', sent[1]?.name === 'sms_click' && sent[1]?.params.method === 'thank_you', JSON.stringify(sent))
expect('phoneEventName is case-insensitive', phoneEventName('SMS:+1') === 'sms_click' && phoneEventName('tel:+1') === 'phone_click')

// 3. StickyCta: call button only when a dialable phone is given; nothing broken without one.
const base = { packageName: 'Aruba', requestLabel: 'Request Info', bookLabel: 'Book' }
const withPhone = renderToStaticMarkup(createElement(StickyCta, { ...base, phone: site.phone, callLabel: 'Call or text now' }))
expect('StickyCta has a tel link built from the phone prop', /href="tel:\+1\d{10}"/.test(withPhone), withPhone)
expect('StickyCta is hidden from lg up', withPhone.includes('lg:hidden'))
expect('StickyCta shows the call label', withPhone.includes('Call or text now'))
for (const empty of [undefined, null, '', '   ', 'not a number']) {
  const out = renderToStaticMarkup(createElement(StickyCta, { ...base, phone: empty as string | null | undefined }))
  expect(`StickyCta draws no call button for phone=${JSON.stringify(empty)}`, !out.includes('tel:') && out.includes('Request Info'), out)
}
const custom = renderToStaticMarkup(createElement(StickyCta, { ...base, requestHref: '/contact#enquire' }))
expect('StickyCta request button follows requestHref', custom.includes('href="/contact#enquire"'))

// 4. Wiring: guide page mounts the bar with the site phone; the four files use PhoneLink, no bare tel anchor.
const guidePage = read('components/guide-page.tsx')
expect('guide-page mounts StickyCta with the site phone', /<StickyCta[\s\S]*?phone=\{site\.phone\}/.test(guidePage))
expect('guide-page imports StickyCta', /import \{ StickyCta \}/.test(guidePage))
for (const f of ['app/packages/[slug]/page.tsx', 'components/package-card.tsx', 'components/guide-cta.tsx', 'app/thank-you/page.tsx']) {
  const src = read(f)
  expect(`${f} imports PhoneLink`, /import \{ PhoneLink \} from "@\/components\/phone-link"/.test(src))
  expect(`${f} has no bare tel anchor`, !/<a\b[^>]*href=\{[^}]*tel/.test(src) && !/<a\b[^>]*href=["']tel:/.test(src))
  expect(`${f} uses PhoneLink`, src.includes('<PhoneLink'))
}
expect('package page passes the phone to StickyCta', /<StickyCta[^>]*phone=\{request\.phone\}/.test(read('app/packages/[slug]/page.tsx')))
expect('sticky bar watches #enquire, #contact and the guide CTA', /"enquire", "contact", "guide-cta"/.test(read('components/sticky-cta.tsx')) && read('components/guide-cta.tsx').includes('id="guide-cta"'))

// 5. Translations and text rules.
for (const key of ['Call or text now', 'Call or text our AI agent']) {
  for (const lang of ['fr', 'es'] as const) {
    const t = translate(lang, key)
    expect(`${lang} translation for "${key}"`, t !== key && t.length > 0, t)
  }
}
const changed = ['components/phone-link.tsx', 'components/sticky-cta.tsx', 'components/guide-page.tsx', 'components/guide-cta.tsx', 'scripts/check-phone-link.ts']
const addedLines = execFileSync('git', ['diff', 'HEAD', '--unified=0', '--', ...changed], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
expect('no em dash in added lines of changed files', addedLines.every((l) => !l.includes(DASH)))
expect('no em dash in the new component', !read('components/phone-link.tsx').includes(DASH))
expect('no em dash in new i18n strings', !read('lib/i18n.ts').split('\n').filter((l) => l.includes('Call or text now') || l.includes('Call or text our AI')).some((l) => l.includes(DASH)))

// 6. The phone number itself is untouched.
let siteDiff = 'unknown'
try {
  siteDiff = execFileSync('git', ['diff', '--stat', 'HEAD', '--', 'lib/site.ts'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  siteDiff = 'unknown'
}
expect('lib/site.ts is unchanged', siteDiff === '', siteDiff)
expect('CTA phone is the AI agent line', site.phone === '(833) 878-5386', site.phone)

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll phone link checks passed')
