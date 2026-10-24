// Offline source-scan check: the email-only signup box (WP: run2-signup) is on guide, blog, compare and best-time pages,
// exactly once each, built from the existing TripAlertForm with an UNTICKED consent box, and its heading is translated.
// Run: pnpm dlx tsx scripts/check-signup-boxes.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate } from '../lib/i18n'
import { tripAlertSubmissionSchema } from '../lib/schemas/trip-alert'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const count = (s: string, needle: string) => s.split(needle).length - 1

// 1. Each page type renders the box exactly once and passes its own path as the source.
const pages: Array<[string, string, RegExp]> = [
  ['guide pages (all kinds)', 'components/guide-page.tsx', /<PageSignupBox path=\{guidePath\(kind, slug\)\}/],
  ['blog post pages', 'app/blog/[slug]/page.tsx', /<PageSignupBox path=\{`\/blog\/\$\{post\.slug\}`\}/],
  ['compare pages', 'app/compare/[pair]/page.tsx', /<PageSignupBox path=\{`\/compare\/\$\{params\.pair\}`\}/],
  ['best-time pages', 'app/best-time-to-visit/[destination]/page.tsx', /<PageSignupBox path=\{`\/best-time-to-visit\/\$\{params\.destination\}`\}/],
]
for (const [label, file, re] of pages) {
  const src = read(file)
  expect(`${label}: imports PageSignupBox`, src.includes('import { PageSignupBox } from "@/components/page-signup-box"'))
  expect(`${label}: renders it exactly once with its own path`, count(src, '<PageSignupBox') === 1 && re.test(src))
  expect(`${label}: does not also render a second TripAlertForm`, !src.includes('<TripAlertForm'))
  expect(`${label}: box sits before the footer`, src.indexOf('<PageSignupBox') < src.indexOf('<Footer'))
}
// Placement relative to related links.
const guide = read('components/guide-page.tsx')
expect('guide: box is after the enquiry CTA and before related guides and the Keep exploring links', guide.indexOf('<GuideCta') < guide.indexOf('<PageSignupBox') && guide.indexOf('<PageSignupBox') < guide.indexOf('<RelatedGuidesSection') && guide.indexOf('<PageSignupBox') < guide.indexOf('Keep exploring'))
const blog = read('app/blog/[slug]/page.tsx')
expect('blog: box is after the article body and before More stories and related guides', blog.indexOf('<PageSignupBox') > blog.indexOf('<AffiliateAutoDisclosure') && blog.indexOf('<PageSignupBox') < blog.indexOf('id="more-stories-heading"') && blog.indexOf('<PageSignupBox') < blog.indexOf('id="post-guides-heading"'))
const best = read('app/best-time-to-visit/[destination]/page.tsx')
expect('best-time: box is after the content blocks and the enquiry CTA', best.indexOf('<PageSignupBox') > best.indexOf('<GuideCta'))
const cmp = read('app/compare/[pair]/page.tsx')
expect('compare: box is after the enquiry CTA', cmp.indexOf('<PageSignupBox') > cmp.indexOf('<GuideCta'))

// 2. The box wraps the existing form with the page path; the form keeps consent unticked and keeps its wording.
const box = read('components/page-signup-box.tsx')
expect('box renders TripAlertForm with the page path as source', /<TripAlertForm source=\{path\} language=\{language\} \/>/.test(box))
expect('box heading goes through translate()', box.includes('translate(language, "Hear about our next trips")'))
const form = read('components/trip-alert-form.tsx')
expect('consent state starts false (unticked)', /useState\(false\)/.test(form) && /const \[consent, setConsent\] = useState\(false\)/.test(form))
expect('consent checkbox is controlled by that state, never defaultChecked or checked', /checked=\{consent\}/.test(form) && !/defaultChecked|checked=\{true\}|checked(?=[\s/>])/.test(form.replace(/checked=\{consent\}/g, '').replace(/e\.target\.checked/g, '')))
expect('form keeps the CASL consent wording', form.includes('"Yes, I agree to receive travel deals and updates from"') && form.includes('"by email. I can unsubscribe at any time."'))
expect('form refuses to submit without the tick', form.includes('if (!consent) return setError'))
expect('form keeps the honeypot field and posts to /api/trip-alerts with the source', form.includes('company_website') && form.includes('"/api/trip-alerts"') && form.includes('JSON.stringify({ slug, source, email'))
expect('form still has the trip page usage (slug)', (read('app/packages/[slug]/page.tsx') + read('components/trip/past-trip-page.tsx') + read('components/trip/trip-kit-page.tsx')).includes('<TripAlertForm slug={pkg.slug}'))

// 3. The API accepts a slugless sign-up with a source, still needs consent, and keeps the guards.
const base = { email: 'a@b.co', consent: true, source: '/blog/x' }
expect('schema accepts email + consent + source with no slug', tripAlertSubmissionSchema.safeParse(base).success)
expect('schema still refuses an unticked consent', !tripAlertSubmissionSchema.safeParse({ ...base, consent: false }).success)
expect('schema refuses a source that is not a site path', !tripAlertSubmissionSchema.safeParse({ ...base, source: 'https://evil.example' }).success)
const route = read('app/api/trip-alerts/route.ts')
expect('route keeps honeypot and rate limit before any save', route.indexOf('isHoneypotFilled') < route.indexOf('allowRequest') && route.indexOf('allowRequest') < route.indexOf('saveLeadFirst'))
expect('route records the page as the lead source when there is no trip', route.includes('Signed up for trip alerts from the page') && route.includes('page_path'))

// 4. Translations: the new heading exists in French and Spanish and no em dash.
const heading = 'Hear about our next trips'
const fr = translate('fr', heading)
const es = translate('es', heading)
expect('heading has a French translation', fr !== heading && fr.length > 0, fr)
expect('heading has a Spanish translation', es !== heading && es.length > 0, es)
expect('no em dashes in the new strings', ![heading, fr, es].some((s) => s.includes('—')))

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nAll signup box checks passed')
