// Pure checks for the growth loop WP1 rotation and quality gate. No database, no AI.
// Run: pnpm dlx tsx scripts/check-content-styles.ts
import { CONTENT_STYLES, CTA_STYLES, pickStyle, pickCtaStyle, ctaFor, STYLE_WINDOW } from '../lib/content-styles'
import { autoPublishBlockers, normalizePost, cutAtWord, fixDashes, findOffenders, applyRewrites, gateWithRepair, type ComposedPost } from '../lib/blog-composer'

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
      if (targets.length === 0 || targets.some((t) => !allowed.has(t)) || text.includes('2014') || /\d/.test(text)) {
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
check('em dash in body is caught', has(run({ ...good, body: good.body + ' a ' + String.fromCharCode(0x2014) + ' b' }), 'long dash'))
check('em dash in FAQ is caught', has(run({ ...good, faq: [{ q: 'q' + String.fromCharCode(0x2014) + '', a: 'a' }, ...good.faq.slice(1)] }), 'long dash'))
check('foreign number in FAQ is caught', has(run({ ...good, faq: [{ q: 'How long?', a: 'About 14 days.' }, ...good.faq.slice(1)] }), 'number not in'))
check('foreign number in takeaways is caught', has(run({ ...good, key_takeaways: ['Costs 999 dollars', 'b', 'c'] }), 'number not in'))
check('foreign number in body is caught', has(run({ ...good, body: good.body + '\n\nThe ship carries 180 guests.' }), 'number not in'))
check('number from the grounding text is allowed', run({ ...good, body: good.body + '\n\nIt runs in November 2026.' }).length === 0)
check('list numbering is not a claim', run({ ...good, body: good.body + '\n\n1. First\n2. Second\n\n## 3. Third thing' }).length === 0)
check('missing FAQ is caught', has(run({ ...good, faq: [] }), 'missing FAQ'))
check('missing takeaways is caught', has(run({ ...good, key_takeaways: [] }), 'missing key takeaways'))
check('OG title over 60 characters is caught', has(run({ ...good, og_title: 'x'.repeat(61) }), 'social title'))

// ---- fix round 1 ----
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

// 1. OG length is repaired, not blocked.
{
  const words = 'a plain guide to river cruising for first timers who want an easy pace'
  const long = normalizePost({ ...good, seo_title: 'River cruise for first timers: a plain guide', og_title: words + ' ' + words, og_description: (words + ' ').repeat(6) })
  check('long OG title falls back to the SEO title, within 60', long.og_title === 'River cruise for first timers: a plain guide' && long.og_title.length <= 60, long.og_title)
  check('long OG description is cut at a word boundary within 110', long.og_description.length <= 110 && (words + ' ').repeat(6).startsWith(long.og_description) && !/\s$/.test(long.og_description), long.og_description)
  const cut = cutAtWord('abcdefghij klmnopqrst uvwxyz', 15)
  check('cutAtWord never cuts mid-word', cut === 'abcdefghij', cut)
  const empty = normalizePost({ ...good, og_title: '', og_description: '', seo_description: 'x '.repeat(80) })
  check('empty OG description falls back to the SEO description, within 110', empty.og_description.length > 0 && empty.og_description.length <= 110)
  check('a repaired post has no length blockers', autoPublishBlockers(long, now, ctx).length === 0, autoPublishBlockers(long, now, ctx).join(' | '))
}

// 2. Dashes are replaced in every field.
{
  const dirty = normalizePost({
    ...good,
    title: `River${EM}cruise`,
    seo_title: `A ${EM} B`,
    seo_description: `x${EN}y`,
    body: `${good.body}\n\nOne ${EM} two.\n\nRange 5${EN}7 here.\n- a list item`,
    faq: [{ q: `Q ${EM} one?`, a: `A${EM}one` }, ...good.faq.slice(1)],
    key_takeaways: [`T ${EM} one`, 'b', 'c'],
    og_title: `O ${EM} t`,
    og_description: `D ${EM} d`,
    primary_keyword: `k${EM}k`,
  })
  const all = JSON.stringify(dirty)
  check('no long dashes survive anywhere', !all.includes(EM) && !all.includes(EN))
  check('dash becomes a comma; digit range becomes "to"', dirty.body.includes('One, two.') && dirty.body.includes('5 to 7') && dirty.title === 'River, cruise')
  check('line breaks and list markers survive', dirty.body.includes('\n- a list item'))
  check('fixDashes leaves ordinary hyphens', fixDashes('well-known') === 'well-known')
}

// 3. Number grounding comes from the facts only; title and social text are gated too.
check('AI keywords no longer license a number', has(run({ ...good, tags: ['river cruise 14 days'], primary_keyword: '14 day river cruise', body: good.body + '\n\nIt runs for 14 days.' }), 'number not in'))
check('digit in title is caught', has(run({ ...good, title: 'Ten reasons, 7 of them' }), 'number not in'))
check('digit in SEO description is caught', has(run({ ...good, seo_description: 'Top 5 tips' }), 'number not in'))
check('digit in OG text is caught', has(run({ ...good, og_title: '5 things', og_description: 'About 9 things' }), 'number not in'))
check('grounded digit in the title is allowed', run({ ...good, title: 'The Rhine trip in 2026' }).length === 0)

// 5. Word numbers.
check('word number with a unit is caught', has(run({ ...good, body: good.body + '\n\nIt is a three-night stay.' }), 'word number'))
check('word number allowed when the facts say it in words', autoPublishBlockers({ ...good, body: good.body + '\n\nIt is a three nights stay.' }, now, { ...ctx, groundingText: ctx.groundingText + ' three nights on board' }).length === 0)
check('word number allowed when the facts say it in digits', autoPublishBlockers({ ...good, body: good.body + '\n\nIt is a three night stay.' }, now, { ...ctx, groundingText: ctx.groundingText + ' 3 nights on board' }).length === 0)
check('word number without a unit is not a claim', run({ ...good, body: good.body + '\n\nThere are two ways to see it.' }).length === 0)

// 6. Links.
check('absolute link to our own domain is converted to a path and passes', run({ ...good, body: good.body + '\n\n[x](https://www.travelfunbiz.ca/packages/rhine-cruise)' }).length === 0)
check('absolute link to our own domain with a dead path is caught', has(run({ ...good, body: good.body + '\n\n[x](https://travelfunbiz.ca/packages/nope)' }), 'link to a page'))
check('other web link is a blocker', has(run({ ...good, body: good.body + '\n\n[x](https://example.com/page)' }), 'external'))
check('mailto link is a blocker', has(run({ ...good, body: good.body + '\n\n[x](mailto:a@b.co)' }), 'external'))
check('link with a title attribute is still checked', has(run({ ...good, body: good.body + '\n\n[x](/packages/nope "t")' }), 'link to a page'))
check('link inside a FAQ answer is a blocker', has(run({ ...good, faq: [{ q: 'Q?', a: 'See [this](/packages/rhine-cruise).' }, ...good.faq.slice(1)] }), 'FAQ'))
check('our-team and award claims are blocked', has(run({ ...good, body: good.body + '\n\nOur guests loved it. An award-winning ship.' }), 'experience'))

// 4. The single repair: offenders are found, rewrites are applied, and the gate passes after.
{
  const bad = { ...good, body: good.body + '\n\nThe ship holds 180 guests. It is a gentle trip.\n\nSee [a](/packages/nope) too.', key_takeaways: ['Costs 999 dollars', 'b', 'c'] }
  const offenders = findOffenders(bad, ctx)
  check('offenders name the exact sentences', offenders.some((o) => o.field === 'body' && o.text === 'The ship holds 180 guests.') && offenders.some((o) => o.field === 'takeaway') && offenders.some((o) => o.text.includes('/packages/nope')), JSON.stringify(offenders.map((o) => o.text)))
  check('clean sentences are not offenders', !offenders.some((o) => o.text === 'It is a gentle trip.'))
  const fixed = applyRewrites(bad, offenders, offenders.map((o, id) => ({ id, text: o.field === 'takeaway' ? 'Good value' : o.text.includes('/packages/nope') ? 'See more too.' : 'The ship is a comfortable size.' })))
  check('after the rewrites the gate is clean', autoPublishBlockers(fixed, now, ctx).length === 0, autoPublishBlockers(fixed, now, ctx).join(' | '))
  const missing = findOffenders({ ...bad, faq: [] }, ctx)
  check('offenders are still found alongside a structural blocker', missing.length > 0)
}

// 9. Window first, then drop unstyled posts.
check('only the last ten posts count', pickStyle([...Array(STYLE_WINDOW).fill(null), 'listicle', 'listicle']).id === CONTENT_STYLES[0].id)
check('pickCtaStyle never repeats the latest', CTA_STYLES.every((c) => pickCtaStyle([c.id]).id !== c.id))

// ---- fix round 2 ----
check('"a couple of days" and "a dozen ports" are not flagged', run({ ...good, key_takeaways: ['Spend a couple of days', 'a dozen ports', 'c'] }).length === 0)
check('word number needs the same unit in the facts', has(autoPublishBlockers({ ...good, body: good.body + '\n\nIt is a three day stay.' }, now, { ...ctx, groundingText: ctx.groundingText + ' 3 nights on board' }), 'word number'))
{
  check('a leading dash is dropped, not turned into a comma', fixDashes(EM + ' Start here') === 'Start here' && fixDashes('a\n' + EN + ' b') === 'a\nb', JSON.stringify(fixDashes('a\n' + EN + ' b')))
  check('a trailing dash leaves no dangling comma', fixDashes('Wait ' + EM) === 'Wait' && fixDashes('Wait ' + EM + '\nnext') === 'Wait\nnext')
  check('a dash in the middle still becomes a comma', fixDashes('one ' + EM + ' two') === 'one, two')
}
{
  const withList = { ...good, body: good.body + '\n\n- The ship holds 180 guests.\n1. Another 99 things.\n## 4 reasons to go\n\nPlain text.' }
  const off = findOffenders(withList, ctx)
  const bullet = off.find((o) => o.text.includes('180'))
  check('list and heading markers are separated from the sentence', bullet?.prefix === '- ' && off.some((o) => o.prefix === '1. ') && off.every((o) => !o.prefix || o.text.startsWith(o.prefix)), JSON.stringify(off.map((o) => [o.prefix, o.text])))
  const fixed = applyRewrites(withList, off, off.map((o, id) => ({ id, text: o.prefix ? o.prefix + 'A general point.' : 'A general point.' })))
  check('markers are re-attached once and never doubled', fixed.body.includes('\n- A general point.') && !fixed.body.includes('- - ') && !fixed.body.includes('1. 1. '))
  const kept = applyRewrites(withList, off, off.map((_, id) => ({ id, text: '  ' })))
  check('an empty rewrite keeps the original sentence', kept.body === withList.body)
}
check('a post that skipped enrich is held with its own reason', has(run({ ...good, faq: [], key_takeaways: [], skipped_enrich: true }), 'ran out of time for FAQ'))

;(async () => {
  const late = await gateWithRepair({ ...good, body: good.body + '\n\nThe ship holds 180 guests.' }, now, { ...ctx, deadlineMs: Date.now() + 10_000 })
  check('repair is skipped when little time is left', late.repaired === false && has(late.blockers, 'number not in'))
  const timedOut = await gateWithRepair({ ...good, faq: [], key_takeaways: [], skipped_enrich: true }, now, ctx)
  check('a time-skipped post is never sent for repair', timedOut.repaired === false)

  // Single retry: with no AI configured the repair cannot run, so the blockers come back unchanged and unrepaired.
  const r = await gateWithRepair({ ...good, body: good.body + '\n\nThe ship holds 180 guests.' }, now, ctx)
  check('gateWithRepair makes no change when it cannot repair', r.repaired === false && has(r.blockers, 'number not in'))
  const clean = await gateWithRepair(good, now, ctx)
  check('gateWithRepair passes a clean post straight through', clean.repaired === false && clean.blockers.length === 0)
  const structural = await gateWithRepair({ ...good, faq: [], body: good.body + '\n\nThe ship holds 180 guests.' }, now, ctx)
  check('a structural blocker is never sent for repair', structural.repaired === false)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
})()
