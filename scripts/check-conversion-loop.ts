// Offline check: the conversion loop (visit -> lead). Pure helpers and file text only. No network, no database.
// Run: pnpm dlx tsx scripts/check-conversion-loop.ts   (exit 1 on a failure)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  contextCtaCopy,
  cleanSubject,
  GENERIC_SUBJECT,
  cleanTopic,
  aboutLine,
  messageWithContext,
  enquiryHrefWithContext,
  splitAfterQuickAnswer,
  pageTypeOfPath,
  funnelByPageType,
  CONVERSION_EVENTS,
  CTA_BLOCK_IDS,
} from '../lib/conversion'
import { buildGuideLeadPayload } from '../lib/guide-lead-form'
import { contactSubmissionSchema } from '../lib/schemas/contact'
import { touchFromAttribution } from '../lib/lead-touch'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

// ---- CTA copy built from fixtures ------------------------------------------------------------------------------
const subjects = ['Croatia', 'Aruba', 'Greece vs Italy', `Best time ${EM} Croatia`, '', null, undefined, 'x'.repeat(200), 'Alaska cruise?']
const phones = ['(555) 010-2030', '', null]
const allCopy: string[] = []
let onePrimary = true
for (const s of subjects) {
  for (const p of phones) {
    const c = contextCtaCopy({ subject: s, phone: p })
    allCopy.push(c.heading, c.body, c.nextStep, c.primaryLabel, c.secondaryLabel ?? '')
    // One primary action: call when there is a number (with a quiet enquiry link), else the enquiry alone.
    if (p) onePrimary = onePrimary && c.primary === 'call' && c.secondaryLabel !== null
    else onePrimary = onePrimary && c.primary === 'enquiry' && c.secondaryLabel === null
  }
}
const text = allCopy.join('\n')
expect('CTA copy has no em or en dashes', !text.includes(EM) && !text.includes(EN))
expect('CTA copy has no prices', !/[$€£]|\b\d+\s?(usd|cad|dollars?)\b|\bfrom \d/i.test(text))
expect('CTA copy has no invented counts', !/\b\d+\s*(travell?ers|people|clients|families|trips|reviews|guests|customers)\b/i.test(text) && !/\b(thousands|hundreds|millions)\b/i.test(text))
expect('CTA copy makes no response-time promise', !/(within|in under|in less than|same.day|24 ?h|48 ?h|minutes?|hours?|instantly|immediately|right away|asap|soon|today|\bfast\b|quickly)/i.test(text.replace(/\(555\) 010-2030/g, '')))
expect('CTA copy has no fake urgency', !/(limited|hurry|last chance|only \d|act now|don't miss|selling out|ends)/i.test(text))
expect('exactly one primary action per block', onePrimary)
expect('heading names the subject', contextCtaCopy({ subject: 'Croatia', phone: '' }).heading === 'Planning Croatia? Talk to a travel advisor.')
expect('missing, empty or very long subject falls back to a generic one', cleanSubject('') === GENERIC_SUBJECT && cleanSubject(null) === GENERIC_SUBJECT && cleanSubject('x'.repeat(200)) === GENERIC_SUBJECT)
expect('subject dashes are removed', !cleanSubject(`Best time ${EM} Croatia`).includes(EM) && !cleanSubject(`A ${EN} B`).includes(EN))
expect('trailing question mark is not doubled', contextCtaCopy({ subject: 'Alaska cruise?', phone: '' }).heading === 'Planning Alaska cruise? Talk to a travel advisor.')
expect('call label carries the site phone as given', contextCtaCopy({ subject: 'Croatia', phone: '(555) 010-2030' }).primaryLabel === 'Call or text (555) 010-2030')
expect('two distinct block ids', new Set(CTA_BLOCK_IDS).size === 2)

// ---- Consent wording unchanged ----------------------------------------------------------------------------------
// Pulls every consent sentence out of the three forms and hashes them. If anyone edits the approved wording this fails.
function consentStrings(file: string): string[] {
  const src = read(file)
  const out: string[] = []
  for (const m of src.matchAll(/translate\(language,\s*(['"])((?:(?!\1).)*)\1\)/g)) {
    if (/agree|unsubscribe/i.test(m[2])) out.push(m[2])
  }
  return out
}
const consent = [...consentStrings('components/contact-form.tsx'), ...consentStrings('components/newsletter-form.tsx'), ...consentStrings('components/trip-alert-form.tsx')]
const consentHash = createHash('sha256').update(consent.join('\n')).digest('hex')
expect('found all five consent sentences', consent.length === 5, String(consent.length))
expect('consent wording is unchanged (sha256 of the five existing sentences)', consentHash === '92e4de42f39d6b8b961aebe2df40812fa730ad0be225d0099c4b2c3260304aec', consentHash)
expect('new CTA files add no consent sentence', ['components/context-cta.tsx', 'components/thank-you-track.tsx', 'lib/conversion.ts'].every((f) => !/agree to|I consent|unsubscribe/i.test(read(f))))

// ---- Pre-fill mapping ------------------------------------------------------------------------------------------
expect('enquiry link carries trip and topic, query before hash', enquiryHrefWithContext('Aruba Escape', 'Aruba') === '/?package=Aruba%20Escape&about=Aruba#contact')
expect('enquiry link falls back to Custom Package and omits an empty topic', enquiryHrefWithContext(null, '') === '/?package=Custom%20Package#contact')
expect('topic is cleaned (control chars, dashes, length)', cleanTopic(`a\n\tb ${EM} c`) === 'a b - c' && cleanTopic('y'.repeat(300)).length === 80)
expect('about line reads plainly and is empty without a topic', aboutLine('Croatia') === 'I am interested in: Croatia.' && aboutLine('') === '')
expect('message keeps what the visitor typed, after the context line', messageWithContext('Croatia', 'Two couples, June') === 'I am interested in: Croatia. Two couples, June' && messageWithContext('', ' hi ') === 'hi' && messageWithContext(null, '') === '')
const payload = buildGuideLeadPayload({ name: 'Test Visitor', email: 'test@example.com', topic: 'Croatia', packageName: null, attribution: { page_path: '/destinations/croatia', utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'spring', utm_content: 'reel1', referrer: 'https://l.facebook.com/x', landing_path: '/destinations/croatia?utm_source=facebook', utm_term: 'k' } })
expect('guide payload: package falls back, message carries the topic', payload.package === 'Custom Package' && payload.message === 'I am interested in: Croatia.')
expect('guide payload still passes the API schema', contactSubmissionSchema.safeParse(payload).success)
expect('payload without a topic is unchanged (no message)', buildGuideLeadPayload({ name: 'A', email: 'a@b.co' }).message === undefined)
expect('contact form reads the about parameter and keeps the named trip selectable', (() => { const s = read('components/contact-form.tsx'); return s.includes('searchParams?.get("about")') && s.includes('unique.add(packageFromQuery)') })())

// ---- Lead source fields ------------------------------------------------------------------------------------------
const a = payload.attribution!
const touch = touchFromAttribution(a)
expect('lead stores utm source, medium, campaign, content and page path (leads.ts)', (() => { const s = read('lib/leads.ts'); return ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'page_path'].every((k) => s.includes(`${k}: lead.attribution?.${k}`)) })())
expect('referrer is stored as a host only, landing path without the query', touch.referrer === 'l.facebook.com' && touch.landing_path === '/destinations/croatia' && touch.utm_term === 'k')
expect('admin leads list reads page_path and utm_content and shows "Lead source"', read('app/api/admin/leads/route.ts').includes('page_path, utm_content') && read('app/admin/leads/page.tsx').includes('Lead source:'))
expect('without analytics consent only the page path is sent (attribution.ts)', /if \(!analyticsConsented\(\)\) return \{ page_path: window\.location\.pathname \}/.test(read('lib/attribution.ts')))

// ---- Events ----------------------------------------------------------------------------------------------------
expect('the five events exist', ['cta_view', 'cta_click', 'form_start', 'form_submit', 'thank_you_view'].every((e) => (CONVERSION_EVENTS as readonly string[]).includes(e)))
expect('events go through the consent-gated track() only', (() => { const s = read('lib/conversion-events.ts'); return s.includes("from '@/lib/analytics-client'") && !/\bfetch\(|sendBeacon|localStorage/.test(s) })())
expect('events are wired: view, click, form start, form submit, thank-you view', read('components/context-cta.tsx').includes('"cta_view"') && read('components/context-cta.tsx').includes('"cta_click"') && read('components/guide-lead-form.tsx').includes('"form_start"') && read('components/guide-lead-form.tsx').includes('"form_submit"') && read('components/contact-form.tsx').includes('"form_start"') && read('components/contact-form.tsx').includes('"form_submit"') && read('components/thank-you-track.tsx').includes('thank_you_view'))

// ---- Page wiring -----------------------------------------------------------------------------------------------
const [pre, post] = splitAfterQuickAnswer('<p class="quick-answer"><strong>Quick answer:</strong> yes.</p><p>More</p>')
expect('article splits right after the Quick answer paragraph', pre.endsWith('yes.</p>') && post === '<p>More</p>')
expect('article without a Quick answer is not split', splitAfterQuickAnswer('<p>Only</p>')[1] === '' && splitAfterQuickAnswer('<p>Only</p>')[0] === '<p>Only</p>')
const blog = read('app/blog/[slug]/page.tsx')
expect('blog: context block after the Quick answer, one closing block, sticky bar', blog.includes('blockId="after_quick_answer"') && blog.includes('blockId="end_of_page"') && blog.includes('<StickyCta'))
expect('blog: closing block is the form OR the short block, never both', /relatedPackages\.length > 0 \? \(\s*<ContextCta blockId="end_of_page"[\s\S]*?\) : \(\s*<GuideCta/.test(blog))
expect('guide page: context block after the takeaways, form stays at the end', (() => { const g = read('components/guide-page.tsx'); const i = g.indexOf('<GuideTakeaways'); const j = g.indexOf('blockId="after_quick_answer"'); const k = g.indexOf('<GuideCta name'); return i > -1 && j > i && k > j })())
expect('guide CTA no longer repeats a big enquiry button under the form (a quiet text link stays as the no-JS fallback)', !read('components/guide-cta.tsx').includes('Ask us about your trip') && read('components/guide-cta.tsx').includes('Use the full enquiry page'))
expect('sticky bar also hides while the email signup box is on screen', read('components/sticky-cta.tsx').includes('"page-signup"'))
const ty = read('app/thank-you/page.tsx')
expect('thank-you page: what happens next, trip alerts signup, tracking, no response-time promise in the new block', ty.includes('What happens next') && ty.includes('<TripAlertForm') && ty.includes('<ThankYouTrack') && !/within|minutes|hours|24|48/i.test(ty.slice(ty.indexOf('What happens next'), ty.indexOf('What happens next') + 400)))
const newFiles = ['lib/conversion.ts', 'lib/conversion-events.ts', 'components/context-cta.tsx', 'components/thank-you-track.tsx']
expect('new files have no em dashes', newFiles.every((f) => !read(f).includes(EM)))

// ---- Funnel by page type ---------------------------------------------------------------------------------------
expect('page types', pageTypeOfPath('/blog/x') === 'blog' && pageTypeOfPath('/destinations/croatia?x=1') === 'guide' && pageTypeOfPath('/compare/a-vs-b') === 'compare' && pageTypeOfPath('/best-time-to-visit/aruba') === 'best-time' && pageTypeOfPath('/from/toronto') === 'from-city' && pageTypeOfPath('/packages/aruba') === 'trip' && pageTypeOfPath('/') === 'home' && pageTypeOfPath(null) === 'other' && pageTypeOfPath('/thank-you') === 'other')
const rows = funnelByPageType(['/blog/a', '/blog/b', '/destinations/x', '/'], ['/blog/a', '/destinations/x', '/destinations/y', null])
const blogRow = rows.find((r) => r.type === 'blog')!
expect('funnel: counts visits and leads by page type, per-100 only with visits', blogRow.visits === 2 && blogRow.leads === 1 && blogRow.per100 === 50 && rows.find((r) => r.type === 'guide')!.leads === 2)
const noVisits = funnelByPageType(null, ['/blog/a'])
expect('funnel: visits not measured is null, never zero', noVisits[0].visits === null && noVisits[0].per100 === null && noVisits[0].leads === 1)
expect('funnel: zero visits gives no rate', funnelByPageType([], ['/blog/a'])[0].per100 === null)
expect('funnel panel says "not measured" and names what is not measured', read('components/admin/funnel-panel.tsx').includes('not measured') && read('components/admin/funnel-panel.tsx').includes('Enquiry-form views and form starts are not measured'))

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
