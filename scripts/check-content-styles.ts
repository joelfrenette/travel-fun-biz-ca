// Pure checks for the growth loop WP1 rotation and quality gate. No database, no AI.
// Run: pnpm dlx tsx scripts/check-content-styles.ts
import { CONTENT_STYLES, CTA_STYLES, pickStyle, ctaFor, STYLE_WINDOW } from '../lib/content-styles'
import { autoPublishBlockers, type ComposedPost } from '../lib/blog-composer'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

// ---- pickStyle ----
check('seven styles and five CTA styles', CONTENT_STYLES.length === 7 && CTA_STYLES.length === 5)
check('empty history gives the first style', pickStyle([]).id === CONTENT_STYLES[0].id)

// Never the same as the most recent, across every possible most-recent style.
for (const s of CONTENT_STYLES) {
  check(`never repeats most recent (${s.id})`, pickStyle([s.id]).id !== s.id)
}

// Simulate 40 posts: no back-to-back repeats, and every style gets used about evenly.
{
  const history: string[] = []
  let backToBack = 0
  for (let i = 0; i < 40; i++) {
    const next = pickStyle(history).id
    if (history[0] === next) backToBack++
    history.unshift(next)
  }
  const counts = CONTENT_STYLES.map((s) => history.filter((h) => h === s.id).length)
  check('40 simulated posts: no back-to-back repeats', backToBack === 0)
  check('40 simulated posts: usage is balanced', Math.max(...counts) - Math.min(...counts) <= 1, counts.join(','))
}

// Prefers the least used among the last 10.
{
  const recent = ['listicle', 'how-to', 'listicle', 'how-to', 'comparison', 'listicle', 'how-to', 'comparison', 'faq-led', 'faq-led']
  const picked = pickStyle(recent).id
  check('prefers an unused style over used ones', ['story-guide', 'myth-buster', 'checklist'].includes(picked), picked)
}
// Deterministic.
check('deterministic for the same history', pickStyle(['faq-led', 'listicle']).id === pickStyle(['faq-led', 'listicle']).id)
// Ignores unknown and null entries (old posts have no style).
check('ignores null and unknown history entries', pickStyle([null, 'nonsense', undefined]).id === CONTENT_STYLES[0].id)
// Only the last STYLE_WINDOW posts count: an old heavy use of one style is forgotten.
{
  const old = Array.from({ length: 30 }, () => 'checklist')
  const recent = [...CONTENT_STYLES.slice(0, 6).map((s) => s.id).reverse(), ...Array.from({ length: STYLE_WINDOW }, () => 'x'), ...old]
  const picked = pickStyle(recent.filter((r) => r !== 'x'))
  check('window limits how far back it looks', picked.id !== recent[0], picked.id)
}

// ---- ctaFor ----
{
  const pkg = { name: 'Rhine [River] Cruise', slug: 'rhine-cruise' }
  let ok = true
  let why = ''
  for (const c of CTA_STYLES) {
    for (const p of [pkg, null]) {
      const text = ctaFor(c.id, p)
      const targets = [...text.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1])
      const allowed = new Set(['/', '/#contact', ...(p ? [`/packages/${p.slug}`] : [])])
      if (targets.length === 0 || targets.some((t) => !allowed.has(t)) || text.includes('—') || /\d/.test(text)) {
        ok = false
        why = `${c.id}/${p ? 'pkg' : 'none'}: ${text}`
      }
      if (p && text.includes('[River]')) { ok = false; why = 'brackets not stripped' }
    }
  }
  check('CTA links only to the package, /#contact or /; no digits or long dashes', ok, why)
}

// ---- autoPublishBlockers ----
const goodBody = [
  'A river cruise is a relaxed way to see several towns without repacking.',
  '',
  '**Quick answer:** A river cruise suits first timers who want an easy pace.',
  '',
  '## Why a river cruise works for first timers',
  '',
  'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details. ' + 'word '.repeat(460),
  '',
  '### Pace',
  '',
  'Most people find the pace gentle.',
  '',
  'Have a think about who you would travel with, and our team can help you work that out.',
].join('\n')

const good: ComposedPost = {
  title: 'River cruise for first timers',
  slug: 'river-cruise-for-first-timers',
  body: goodBody,
  seo_title: 'River cruise for first timers',
  seo_description: 'A plain guide for first-time river cruisers.',
  tags: ['river cruise first timers'],
  faq: [
    { q: 'Is a river cruise good for first timers?', a: 'Yes, the pace is gentle.' },
    { q: 'Do I unpack every day?', a: 'No, you unpack once.' },
    { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' },
  ],
  key_takeaways: ['Gentle pace', 'Unpack once', 'Good for first timers'],
  og_title: 'Is a river cruise right for you?',
  og_description: 'A plain-English look at river cruising for first timers.',
  primary_keyword: 'river cruise first timers',
  secondary_keywords: ['river cruise tips'],
  content_style: 'faq-led',
}
const ctx = { allowedPaths: ['/packages/rhine-cruise'], groundingText: 'Rhine trip 2026-11-03 to 2026-11-10' }
const now = new Date('2026-10-09T12:00:00Z')
const run = (p: ComposedPost) => autoPublishBlockers(p, now, ctx)
const has = (blockers: string[], needle: string) => blockers.some((b) => b.includes(needle))

check('clean post has no blockers', run(good).length === 0, run(good).join(' | '))
check('dead internal link is caught', has(run({ ...good, body: good.body.replace('/packages/rhine-cruise', '/packages/not-real') }), 'link to a page'))
check('dead destinations link is caught', has(run({ ...good, body: good.body + '\n\n[x](/destinations/atlantis)' }), 'link to a page'))
check('contact and home links are fine', run({ ...good, body: good.body + '\n\n[a](/#contact) [b](/)' }).length === 0)
check('em dash in body is caught', has(run({ ...good, body: good.body + ' a — b' }), 'long dash'))
check('em dash in FAQ is caught', has(run({ ...good, faq: [{ q: 'q—', a: 'a' }, ...good.faq.slice(1)] }), 'long dash'))
check('foreign number in FAQ is caught', has(run({ ...good, faq: [{ q: 'How long?', a: 'About 14 days.' }, ...good.faq.slice(1)] }), 'FAQ or takeaways'))
check('foreign number in takeaways is caught', has(run({ ...good, key_takeaways: ['Costs 999 dollars', 'b', 'c'] }), 'FAQ or takeaways'))
check('foreign number in body is caught', has(run({ ...good, body: good.body + '\n\nThe ship carries 180 guests.' }), 'in the body'))
check('number from the grounding text is allowed', run({ ...good, body: good.body + '\n\nIt runs in November 2026.' }).length === 0)
check('list numbering is not a claim', run({ ...good, body: good.body + '\n\n1. First\n2. Second\n\n## 3. Third thing' }).length === 0)
check('missing FAQ is caught', has(run({ ...good, faq: [] }), 'missing FAQ'))
check('missing takeaways is caught', has(run({ ...good, key_takeaways: [] }), 'missing key takeaways'))
check('OG title over 60 characters is caught', has(run({ ...good, og_title: 'x'.repeat(61) }), 'social title'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
