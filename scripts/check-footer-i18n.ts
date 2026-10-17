// Offline check: every string the footer passes through translate() has a real French and Spanish entry in lib/i18n.ts.
// Keys come from two places so a new footer string cannot slip in untranslated: the literal translate(language, "...") calls in
// components/footer.tsx, and the data lists the footer maps over (content/footer.ts, content/navigation.ts). No network.
// Run: pnpm dlx tsx scripts/check-footer-i18n.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate } from '../lib/i18n'
import { aboutLinks, legalLinks, officeInfo } from '../content/footer'
import { cruiseAndResortLinks, destinationsLink } from '../content/navigation'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const src = readFileSync(join(__dirname, '..', 'components', 'footer.tsx'), 'utf8')
const keys = new Set<string>()
// translate(language, "literal") with a single, double or backtick-free quoted literal.
for (const m of src.matchAll(/translate\(\s*language\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g)) keys.add((m[1] ?? m[2]).replace(/\\(['"])/g, '$1'))
for (const l of [...aboutLinks, ...legalLinks, destinationsLink, ...cruiseAndResortLinks]) keys.add(l.label)
for (const d of officeInfo.disclaimers) keys.add(d)

expect('the footer has translatable strings to check (the scan found the known ones)', ['Trips by destination', 'Explore', 'Cookie settings', 'NOTIFY ME OF', 'TRAVEL DEALS'].every((k) => keys.has(k)), [...keys].join(' | '))

// Names that are the same in every language on purpose (a proper noun or an international word) need no change.
const SAME_ON_PURPOSE = new Set<string>(['fr:Destinations', 'fr:Yachts'])

for (const key of [...keys].sort()) {
  for (const lang of ['fr', 'es'] as const) {
    const out = translate(lang, key)
    const ok = out !== key || SAME_ON_PURPOSE.has(`${lang}:${key}`)
    expect(`${lang}: "${key.length > 60 ? `${key.slice(0, 57)}...` : key}" is translated`, ok, out)
  }
}

const dash = /[–—]/
for (const key of keys) for (const lang of ['fr', 'es'] as const) if (dash.test(translate(lang, key))) expect(`${lang}: no dash characters in the translation of "${key.slice(0, 40)}"`, false)

process.exit(failures === 0 ? 0 : 1)
