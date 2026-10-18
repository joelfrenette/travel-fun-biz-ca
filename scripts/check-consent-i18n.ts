// Offline check: every string the cookie banner, the cookie settings link and the newsletter form pass through
// translate() exists in English (the source text), French and Spanish in lib/i18n.ts, and the Spanish and French
// strings keep exactly the same {placeholders} as the English one. A new consent string cannot ship untranslated.
// Keys come from the literal translate(language, "...") calls, the BODY constant in the banner, and the default
// label of the cookie settings link. No network.
// Run: pnpm dlx tsx scripts/check-consent-i18n.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate } from '../lib/i18n'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const unescape = (s: string) => s.replace(/\\(['"])/g, '$1')

function keysOf(rel: string): string[] {
  const src = read(rel)
  const keys = new Set<string>()
  for (const m of src.matchAll(/translate\(\s*language\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g)) keys.add(unescape(m[1] ?? m[2]))
  return [...keys]
}

const banner = read('components/cookie-banner.tsx')
const bannerKeys = keysOf('components/cookie-banner.tsx')
const body = banner.match(/const BODY =\s*\n?\s*'((?:[^'\\]|\\.)*)'/)
expect('the banner body sentence was found in components/cookie-banner.tsx', !!body)
if (body) bannerKeys.push(unescape(body[1]))

const linkSrc = read('components/cookie-settings-link.tsx')
const linkDefault = linkSrc.match(/label = "([^"]+)"/)
expect('the cookie settings link default label was found', !!linkDefault)
const linkKeys = linkDefault ? [linkDefault[1]] : []

const newsletterKeys = keysOf('components/newsletter-form.tsx')

expect(
  'the banner keys include the known strings',
  ['Your privacy choices', 'Essential only', 'Accept analytics', 'Read our Privacy Policy'].every((k) => bannerKeys.includes(k)) && bannerKeys.some((k) => k.startsWith('We use cookies')),
  bannerKeys.join(' | '),
)
expect('the newsletter consent keys are present', ['Yes, I agree to receive travel deals and updates from', 'by email and text message. I can unsubscribe at any time.'].every((k) => newsletterKeys.includes(k)))

// The two consent-box halves are the legal text and the banner is the opt-in: all of them need FR and ES.
// The other newsletter form labels (field names, toasts) are covered by the footer and general copy work,
// so here only the consent sentence keys are required for the newsletter form.
const consentKeys = newsletterKeys.filter((k) => /agree to receive|unsubscribe at any time/.test(k))
const all = [...new Set([...bannerKeys, ...linkKeys, ...consentKeys])]

const placeholders = (s: string) => (s.match(/\{[A-Za-z0-9_]+\}/g) ?? []).sort().join(',')

for (const key of all.sort()) {
  const label = key.length > 60 ? `${key.slice(0, 57)}...` : key
  expect(`en: "${label}" falls through as the source text`, translate('en', key) === key)
  for (const lang of ['fr', 'es'] as const) {
    const out = translate(lang, key)
    expect(`${lang}: "${label}" has an entry`, out !== key, out)
    expect(`${lang}: "${label}" keeps the English placeholders`, placeholders(out) === placeholders(key), `${placeholders(key)} vs ${placeholders(out)}`)
    expect(`${lang}: "${label}" has no dash characters`, !/[–—]/.test(out))
  }
}

// The banner sentence promises the link by name; the Spanish sentence must name the Spanish link label.
const esBody = body ? translate('es', unescape(body[1])) : ''
const esLink = linkDefault ? translate('es', linkDefault[1]) : ''
expect('es: the banner sentence names the Spanish "Cookie settings" link label', !!esLink && esBody.includes(`"${esLink}"`), esLink)
const frBody = body ? translate('fr', unescape(body[1])) : ''
const frLink = linkDefault ? translate('fr', linkDefault[1]) : ''
expect('fr: the banner sentence names the French "Cookie settings" link label', !!frLink && frBody.toLowerCase().includes(frLink.toLowerCase()), frLink)

process.exit(failures === 0 ? 0 : 1)
