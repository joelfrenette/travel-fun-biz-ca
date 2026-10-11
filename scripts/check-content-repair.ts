// Offline check for self-healing content (growth loop WP10): the REPAIRABLE / HARD mapping, offending-sentence
// extraction, the deterministic delete fallback, the model path (with a fake model), the SEO score, the cheap fixers,
// the daily slots and the "log, then apply" rule. No network, no real database.
// Run: pnpm dlx tsx scripts/check-content-repair.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guideBlockers, type ComposedGuide } from '../lib/guide-composer'
import { autoPublishBlockers, type ComposedPost } from '../lib/blog-composer'
import { copyGroundingText, pageCopyBlockers, type ComposedPageCopy, type CopyGateContext, type PageCopyBrief } from '../lib/page-copy-composer'
import {
  BLOCKER_RULES,
  addInternalLink,
  bodySentences,
  classifyBlockers,
  detectOffenders,
  isNamedPersonLike,
  isPriceOrDate,
  makeDetectCtx,
  repairContent,
  ruleFor,
  stripDeadLinks,
  stripAllLinks,
  internalLinksOfText,
  generateExtras,
  validateRewrite,
  type ModelCall,
  type RepairFields,
} from '../lib/content-repair'
import { buildCopyItem, buildGuideItem, buildPostItem, guideFields, repairComposedGuide } from '../lib/content-repair-adapters'
import { claimDailyOnce, claimRepairSlot, columnsFor, REPAIR_ITEMS_PER_DAY, storedValue } from '../lib/content-edits'
import { addRelatedLinks, linkFirstMention, mergeFaq, planCheapFixes } from '../lib/content-heal-run'
import { seoScore, internalLinkPathsOf } from '../lib/seo-score'
import { serializeField } from '../lib/content-repair'
import { publishDecision } from '../lib/guide-run'

let failed = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `  (${detail})` : ''}`)
}
const EM = String.fromCharCode(0x2014)

// ---------------------------------------------------------------------------------------------------
// 1. classifyBlockers: the mapping
// ---------------------------------------------------------------------------------------------------
const REPAIRABLE_SAMPLES = [
  'superlative or rating claim (best)',
  'number not in the grounding: 12',
  'number not in the source facts (12)',
  'word number not in the source facts (three nights)',
  'em dash present',
  'en dash present',
  'contains a long dash character',
  'unverifiable recency claim',
  'amenity or capacity count',
  'a size, count or date written in words',
  'a count written in words that the grounding does not support: four-night',
  'itinerary or schedule stated as fact',
  'claim about what the agency has done or does: "We host groups here every spring."',
  'named venue or person not in brief: Aquavit Terrace',
  'missing FAQ (0 questions, need at least 4)',
  'missing FAQ (needs at least 3 questions)',
  'missing key takeaways (1, need at least 3)',
  'missing meta title or description',
  '2 FAQ questions, need 3 to 5',
  '7 key takeaways, need 3 to 5',
  'ran out of time for FAQ',
  'external or email link (https://example.com)',
  'link that is not an internal path',
  'dead internal link: /packages/nope',
  'link to a page that was not confirmed to exist (/packages/nope)',
  'link inside FAQ, takeaways or meta text',
  'link inside a FAQ question or answer',
  'no internal link',
  'no internal link in the intro',
  '5 links in the intro, at most 3',
  'weather, crowd or season word: "rain"',
  'says which destination is better (a verdict)',
  'the first sentence compares a destination as better, more or less',
  'social title too long (70 characters)',
  'social description too long (120 characters)',
  'meta title over 42 characters',
  'OG description over 110 characters',
]
const HARD_SAMPLES = [
  'fabricated experience claim',
  'fabricated personal experience claim',
  'placeholder text',
  'model refusal in text',
  'model refusal in body',
  'too short (300 words)',
  'too long (2500 words)',
  'intro too short (50 words, need 150 to 300)',
  '5 sections, expected 6 to 9',
  'no section headings',
  'no primary keyword',
  'the opening paragraph does not name the subject',
  'the intro has a heading',
  'the first sentence is a question, not a direct answer',
  'stale year in title (2024)',
  'web address in text',
  'needs a person: "x" holds a price, a date or a named person',
  'a brand new blocker nobody classified yet',
]
for (const b of REPAIRABLE_SAMPLES) check(`REPAIRABLE: ${b}`, classifyBlockers([b]).repairable.length === 1 && classifyBlockers([b]).hard.length === 0, b)
for (const b of HARD_SAMPLES) check(`HARD: ${b}`, classifyBlockers([b]).hard.length === 1 && classifyBlockers([b]).repairable.length === 0, b)
check('a mixed list is split', (() => { const c = classifyBlockers(['superlative or rating claim (best)', 'placeholder text']); return c.repairable.length === 1 && c.hard.length === 1 })())
check('the mapping is exported as data', BLOCKER_RULES.length > 25 && BLOCKER_RULES.every((r) => r.id && r.pattern instanceof RegExp))

// Drift guard: every blocker the three gates can push must match a rule, so a new gate rule cannot silently become "unknown".
{
  const root = join(__dirname, '..')
  const unknown: string[] = []
  let pushes = 0
  for (const file of ['lib/blog-composer.ts', 'lib/guide-composer.ts', 'lib/page-copy-composer.ts']) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(/blockers\.push\((`[^`]*`|'[^']*')/g)) {
      pushes++
      const literal = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '0')
      if (!ruleFor(literal)) unknown.push(`${file}: ${literal}`)
    }
  }
  check(`all ${pushes} gate blockers are classified`, pushes > 40 && unknown.length === 0, unknown.join(' | '))
}

// ---------------------------------------------------------------------------------------------------
// Fixtures: a clean guide that passes guideBlockers
// ---------------------------------------------------------------------------------------------------
const POOL = [
  'The old town has quiet lanes to wander in the morning.',
  'Small cafes line the main square and open early.',
  'Walking is the easiest way to see the centre.',
  'Local markets sell fruit, bread and handmade gifts.',
  'The harbour is a pleasant place to sit at the end of the day.',
  'Short ferry rides link the nearby villages.',
  'Visitors usually find the pace relaxed and friendly.',
  'A guide can help you choose which streets to explore first.',
]
const para = (n: number, extra: string[] = []) => [...Array.from({ length: n }, (_, i) => POOL[i % POOL.length]), ...extra].join(' ')
const HEADINGS = ['Why visit Santorini', 'Where to stay', 'What to do', 'Food and drink', 'When to go', 'Getting around', 'Who it suits', 'How a group trip works']
function makeGuide(extraBySection: Record<number, string[]> = {}, patch: Partial<ComposedGuide> = {}): ComposedGuide {
  const sections = HEADINGS.map((heading, i) => ({ heading, body: para(16, i === 0 ? ['See [our trips](/packages/greek-isles).', ...(extraBySection[0] ?? [])] : extraBySection[i] ?? []) }))
  return {
    name: 'Santorini',
    summary: 'Santorini is a volcanic Greek island known for its cliffside villages and sunsets.',
    sections,
    body: sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n'),
    faq: ['a', 'b', 'c', 'd'].map((x) => ({ q: `Is Santorini good for groups, question ${x}?`, a: 'Yes, many travellers visit in groups.' })),
    key_takeaways: ['Santorini suits couples and groups', 'Plan transport early', 'Ask us about group trips'],
    meta_title: 'Santorini island guide for group travellers',
    meta_description: 'A plain-English guide to the island of Santorini for group travellers, with what to expect and how to plan.',
    og_title: 'Is Santorini right for your group?',
    og_description: 'What to expect on Santorini.',
    primary_keyword: 'santorini island',
    secondary_keywords: ['santorini trips'],
    hero_query: 'santorini sunset',
    ...patch,
  }
}
const gateCtx = { grounding: 'Subject: destination called "Santorini"\n- "Greek Isles" runs in 2027', allowedPaths: new Set(['/', '/packages', '/packages/greek-isles']), names: ['Greek Isles'] }
const links = [{ path: '/packages/greek-isles', label: 'the "Greek Isles" trip' }, { path: '/packages', label: 'all our trips' }]
const guideItem = (g: ComposedGuide) => buildGuideItem(g, gateCtx, { path: '/destinations/santorini', links })
check('fixture: the clean guide passes the gate', guideBlockers(makeGuide(), gateCtx).length === 0, guideBlockers(makeGuide(), gateCtx).join(' | '))

const noModel: ModelCall = async () => null
const run = (g: ComposedGuide, model: ModelCall = noModel) => repairContent(guideItem(g), { model })

;(async () => {
  // -------------------------------------------------------------------------------------------------
  // 2. Offending-sentence extraction
  // -------------------------------------------------------------------------------------------------
  {
    const g = makeGuide({ 1: ['The harbour is the best place to eat.', 'We offer tours every year.', 'A plain sentence stays.'] })
    const ctx = makeDetectCtx('guide', gateCtx.grounding, ['Santorini', 'Greek Isles'])
    const off = detectOffenders(guideFields(g), ctx)
    check('extracts the superlative sentence', off.some((o) => o.text === 'The harbour is the best place to eat.' && /superlative/.test(o.why)))
    check('extracts the agency-claim sentence', off.some((o) => o.text === 'We offer tours every year.' && /agency/.test(o.why)))
    check('does not flag a plain sentence', !off.some((o) => o.text === 'A plain sentence stays.'))
    check('extracts exactly the two offenders', off.length === 2, String(off.length))
    const sentences = bodySentences('- A bullet item here.\n1. A numbered item.\n## A heading\n\nFirst. Second one.')
    check('list markers stay with the first sentence only and headings are flagged', sentences[0].prefix === '- ' && sentences[1].prefix === '1. ' && sentences[2].heading && sentences[4].prefix === '', JSON.stringify(sentences))
    check('a price or date is recognised', isPriceOrDate('Rooms cost $200 a night.') && isPriceOrDate('Sails on June 5.') && isPriceOrDate('From 450 CAD per person.') && !isPriceOrDate('A trip in 2027.'))
    check('a named-person shape is recognised', isNamedPersonLike('Chef Anna Rossi cooks here.') && isNamedPersonLike('It was founded by Anna Rossi.') && !isNamedPersonLike('The ship has a pool.'))
  }

  // -------------------------------------------------------------------------------------------------
  // 3. Deterministic fallback (no model answers)
  // -------------------------------------------------------------------------------------------------
  {
    const bad = makeGuide({ 1: ['The harbour is the best place to eat.'] })
    check('the bad guide is blocked', guideBlockers(bad, gateCtx).some((b) => /superlative/.test(b)))
    const r = await run(bad)
    check('fallback: the paragraph keeps 2+ sentences, so the sentence is deleted and the gate is clean', r.blockers.length === 0 && !r.fields.body.includes('best place to eat'), r.blockers.join(' | '))
    check('fallback: edit logged with method delete, a before and an after', r.edits.length === 1 && r.edits[0].method === 'delete' && r.edits[0].field === 'body' && r.edits[0].before.includes('best place') && !r.edits[0].after.includes('best place'))
    check('fallback: the model was asked once and gave nothing', r.calls === 1)
    check('fallback: nothing else in the text changed', r.fields.body.replace(/\s+/g, ' ').length < bad.body.replace(/\s+/g, ' ').length && r.fields.faq.length === 4)
    check('fallback: the result still parses into sections for a guide', r.edits[0].after.includes('## Where to stay'))

    // A two-sentence paragraph: the flagged sentence cannot go (the paragraph would fall to one sentence).
    const two = makeGuide({}, {})
    two.sections[2] = { heading: HEADINGS[2], body: 'Dinner is a nice break. The restaurant is world-class.' }
    two.body = two.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n') + '\n\n' + 'Padding. ' + para(40)
    const rt = await repairContent(guideItem({ ...two, sections: [...two.sections] }), { model: noModel })
    check('fallback: a 2-sentence paragraph is NOT cut down to one', rt.fields.body.includes('world-class') && rt.blockers.some((b) => /superlative/.test(b)))

    // Clause trim: the flagged word comes after a comma.
    const clause = makeGuide({ 3: ['The market is lovely, with world-class cheese stalls.'] })
    const rc = await run(clause)
    check('fallback: the clause after the flagged word is cut, the sentence stays', rc.blockers.length === 0 && rc.fields.body.includes('The market is lovely.') && !rc.fields.body.includes('world-class'), rc.blockers.join(' | '))
  }

  // -------------------------------------------------------------------------------------------------
  // 4. HARD blockers and sensitive text are never touched
  // -------------------------------------------------------------------------------------------------
  {
    const exp = makeGuide({ 1: ['When I visited last year the harbour was calm.', 'The harbour is the best place to eat.'] })
    const r = await run(exp)
    check('HARD: an experience claim stops the repair, the text is exactly as it came in', r.hard.length > 0 && r.edits.length === 0 && r.fields.body === exp.body && r.calls === 0)
    // Joel's rule (2026-10-10): an ungrounded price or exact date is DELETED (never reworded) where the paragraph keeps 2+ sentences.
    const price = makeGuide({ 2: ['Rooms cost $200 a night.'] })
    const rp = await run(price)
    check('price: an ungrounded price sentence is deleted, the gate is clean, no model used', rp.blockers.length === 0 && !rp.fields.body.includes('$200') && rp.calls === 0 && rp.hard.length === 0)
    check('price: the edit is method delete with the reason "ungrounded price or date"', rp.edits.length === 1 && rp.edits[0].method === 'delete' && /ungrounded price or date/.test(rp.edits[0].reason) && rp.edits[0].before.includes('$200') && !rp.edits[0].after.includes('$200'))
    check('price: only that sentence went, nothing was added', rp.fields.body.length < price.body.length && rp.fields.body.replace(/\s+/g, ' ').includes('Local markets sell fruit'))
    const date = makeGuide({ 2: ['The ship sails on June 5 each season.'] })
    const rd = await run(date)
    check('date: an exact date sentence is deleted the same way', rd.blockers.length === 0 && !rd.fields.body.includes('June 5') && rd.edits[0]?.method === 'delete' && /ungrounded price or date/.test(rd.edits[0].reason))
    const cad = makeGuide({ 2: ['Fares start at 450 CAD per person.'] })
    const rc = await run(cad)
    check('price: "450 CAD per person" is deleted too', rc.blockers.length === 0 && !rc.fields.body.includes('450'))
    // Where the paragraph would drop under two sentences, it stays HARD and nothing is touched.
    const tiny = makeGuide({})
    tiny.sections[2] = { heading: HEADINGS[2], body: 'Dinner is a nice break. Rooms cost $200 a night.' }
    tiny.body = tiny.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
    const rtiny = await repairContent(guideItem(tiny), { model: noModel })
    check('price: in a 2-sentence paragraph it cannot be deleted, so it is HARD and untouched', rtiny.hard.some((h) => /needs a person/.test(h)) && rtiny.edits.length === 0 && rtiny.fields.body === tiny.body && rtiny.calls === 0)
    const faqPrice = makeGuide({}, { faq: [{ q: 'What does it cost?', a: 'Rooms cost $200 a night.' }, ...makeGuide().faq] })
    const rfp = await run(faqPrice)
    check('price: a FAQ pair holding a price is deleted when enough pairs remain', rfp.blockers.length === 0 && rfp.fields.faq.length === 4 && rfp.edits.some((e) => e.field === 'faq' && e.method === 'delete'))
    const person = makeGuide({ 2: ['Chef Anna Rossi cooks here nightly.'] })
    const rper = await run(person)
    check('person: a sentence about a named person stays HARD and untouched', rper.hard.some((h) => /needs a person/.test(h)) && rper.edits.length === 0 && rper.fields.body === person.body)
    // Outside links: the link goes, the words stay (the address in a link is not a typed-in web address).
    const ext = makeGuide({ 2: ['See [this page](https://example.com) for more.'] })
    const re = await run(ext)
    check('ext-link: an outside link loses the link and keeps its label', re.hard.length === 0 && re.blockers.length === 0 && re.fields.body.includes('See this page for more.') && !re.fields.body.includes('example.com') && re.calls === 0 && re.edits[0].method === 'fixer')
    const mail = makeGuide({ 2: ['Write to [us](mailto:hi@example.com) today.'] })
    const rm = await run(mail)
    check('ext-link: a mailto link is handled the same way', rm.blockers.length === 0 && rm.fields.body.includes('Write to us today.'))
    const bare = makeGuide({ 2: ['Visit https://example.com for more.'] })
    const rb = await run(bare)
    check('ext-link: a web address typed into the text stays HARD', rb.hard.some((h) => /web address/.test(h)) && rb.edits.length === 0 && rb.fields.body === bare.body)
  }

  // -------------------------------------------------------------------------------------------------
  // 5. The model path
  // -------------------------------------------------------------------------------------------------
  {
    const bad = makeGuide({ 1: ['We offer tours every year.', 'The harbour is the best place to eat.'] })
    const seen: string[] = []
    const model: ModelCall = async (prompt) => {
      seen.push(prompt)
      return JSON.stringify({ rewrites: [{ id: 0, text: 'Tours are popular.' }, { id: 1, text: 'The harbour is a place to eat.' }] })
    }
    const r = await run(bad, model)
    check('model: both sentences are reworded (only with words they already had) and the gate is clean', r.blockers.length === 0 && r.fields.body.includes('Tours are popular.') && r.fields.body.includes('The harbour is a place to eat.'), r.blockers.join(' | '))
    check('model: ONE call covered both sentences, method ai', r.calls === 1 && seen.length === 1 && r.edits[0].method === 'ai')
    check('model: the prompt forbids new facts and lists only the offenders', /never add a fact/i.test(seen[0]) && seen[0].includes('We offer tours every year.') && !seen[0].includes('Small cafes line'))
    check('model: the prompt carries only the flagged sentences, no grounding, no package names', !seen[0].includes('Greek Isles') && !seen[0].includes('Subject:') && !seen[0].includes('Small cafes'))

    // A rewrite that adds a number is thrown away, the fallback deletes instead.
    const sneaky: ModelCall = async () => JSON.stringify({ rewrites: [{ id: 0, text: 'The harbour has 40 cafes.' }] })
    const rs = await run(makeGuide({ 1: ['The harbour is the best place to eat.'] }), sneaky)
    check('model: a rewrite that adds a number is rejected, the fallback deletes the sentence', rs.blockers.length === 0 && !rs.fields.body.includes('40') && rs.edits[0].method === 'delete', rs.blockers.join(' | '))
    check('validateRewrite rejects: longer, a new name, a new link, a price', validateRewrite('The harbour is the best place to eat.', 'The harbour is a really pleasant and quiet place to sit and eat dinner.', makeDetectCtx('guide', gateCtx.grounding)) === 'longer than the original' && validateRewrite('The harbour is the best place to eat.', 'Eat at Aquavit Terrace.', makeDetectCtx('guide', gateCtx.grounding)) !== null && validateRewrite('Eat well here.', 'Eat well [here](/packages/x).', makeDetectCtx('guide', gateCtx.grounding)) === 'adds a link' && validateRewrite('Eat well here.', 'Eat for $5.', makeDetectCtx('guide', gateCtx.grounding)) !== null)
    check('validateRewrite accepts a shorter clean rewrite', validateRewrite('The harbour is the best place to eat.', 'The harbour is a place to eat.', makeDetectCtx('guide', gateCtx.grounding)) === null)

    // Round 2 checks.
    const cx2 = makeDetectCtx('guide', 'x', [])
    check('stems: "cities" matches "city", and plural neutral words match', validateRewrite('The cities are the best.', 'The city is well known.', cx2) === null && validateRewrite('The best places for guests.', 'The place for guest.', cx2) === null, String(validateRewrite('The cities are the best.', 'The city is well known.', cx2)))
    check('split: a digit can end a sentence ("from $450. Book now")', bodySentences('Trips start from $450. Book now today.').length === 2 && bodySentences('1. First thing here.').length === 1)
    check('links: a target with parentheses is one link', stripAllLinks('See [Paris](/wiki/Paris_(France)) now.') === 'See Paris now.' && internalLinksOfText('[a](/x_(y))').join() === '/x_(y)')
    check('generateExtras: answered is false for a null call, true for text with nothing accepted', (await generateExtras(async () => null, guideFields(makeGuide()), ['faq'], { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }, null, makeDetectCtx('guide', 'x', []))).answered === false && (await generateExtras(async () => '{"faq":[]}', guideFields(makeGuide()), ['faq'], { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }, null, makeDetectCtx('guide', 'x', []))).answered === true)

    // S1: the subset guard. A rewrite may only reuse the original's words plus a few neutral ones.
    for (const type of ['guide', 'post'] as const) {
      const cx = makeDetectCtx(type, 'Rhine trip', [])
      const rej = (label: string, original: string, rewrite: string) => check(`subset guard (${type}): ${label} is rejected`, validateRewrite(original, rewrite, cx) !== null, String(validateRewrite(original, rewrite, cx)))
      rej('"four-night" -> "week-long"', 'It is a four-night sailing.', 'It is a week-long sailing.')
      rej('"wheelchair accessible"', 'The ship is the best for families.', 'The ship is wheelchair accessible.')
      rej('"free to enter"', 'The museum is world-class.', 'The museum is free to enter.')
      rej('"safe for all travellers with visas"', 'The old town is famous.', 'The old town is safe for all travellers with visas.')
      rej('"We guarantee"', 'The staff are the best.', 'We guarantee the staff.')
      rej('"Hotel Hassler"', 'The hotel is famous.', 'Hotel Hassler is famous.')
      rej('"we offered"', 'The tours are famous.', 'We offered tours.')
      check(`subset guard (${type}): "famous" -> "well known" is accepted`, validateRewrite('The old town is famous for its markets.', 'The old town is well known for its markets.', cx) === null, String(validateRewrite('The old town is famous for its markets.', 'The old town is well known for its markets.', cx)))
      check(`subset guard (${type}): dropping the flagged words is accepted`, validateRewrite('The old town has the best markets.', 'The old town has markets.', cx) === null)
    }

    // The model may delete.
    const del: ModelCall = async () => JSON.stringify({ rewrites: [{ id: 0, delete: true }] })
    const rdl = await run(makeGuide({ 1: ['The harbour is the best place to eat.'] }), del)
    check('model: a delete is honoured when the paragraph allows it', rdl.blockers.length === 0 && !rdl.fields.body.includes('best place'))

    // Calls are capped at two per item, whatever happens.
    let calls = 0
    const counting: ModelCall = async () => {
      calls++
      return 'not json'
    }
    const worst = makeGuide({ 1: ['The harbour is the best place to eat.'] }, { faq: [] })
    const rw = await repairContent(guideItem(worst), { model: counting })
    check('calls: at most 2 model calls per guide (one for the missing FAQ, one for the reword)', calls <= 2 && rw.calls === calls, String(calls))
    let postCalls = 0
    const rpost = await repairContent(guideItem(worst), { model: async () => { postCalls++; return null }, maxCalls: 1 })
    check('calls: a post-style limit of 1 is respected', postCalls === 1 && rpost.calls === 1)
    const none = await repairContent(guideItem(worst), { model: counting, ai: false })
    check('calls: ai:false uses no model at all', none.calls === 0)
    const late = await repairContent(guideItem(worst), { model: counting, deadlineMs: Date.now() + 10_000 })
    check('calls: no model call starts with little time left', late.calls === 0)
  }

  // -------------------------------------------------------------------------------------------------
  // 6. Missing FAQ / takeaways / meta text: regenerated from the body only
  // -------------------------------------------------------------------------------------------------
  {
    const gen: ModelCall = async (prompt) => {
      check('generate: the prompt hands over the page text and nothing invented', prompt.includes('The old town has quiet lanes') && /Never add a fact/i.test(prompt))
      return JSON.stringify({
        faq: [
          { q: 'Is Santorini easy to walk around?', a: 'Walking is the easiest way to see the centre.' },
          { q: 'Are there markets in Santorini?', a: 'Local markets sell fruit, bread and handmade gifts.' },
          { q: 'Is the pace relaxed on Santorini?', a: 'Visitors usually find the pace relaxed and friendly.' },
          { q: 'Is a ferry ride easy to take on Santorini?', a: 'Short ferry rides link the nearby villages.' },
        ],
        key_takeaways: ['Walking is the easiest way around', 'Markets sell local food and gifts', 'The pace is relaxed'],
      })
    }
    const r = await run(makeGuide({}, { faq: [], key_takeaways: [] }), gen)
    check('generate: the FAQ and takeaways are written, the gate is clean', r.blockers.length === 0 && r.fields.faq.length === 4 && r.fields.key_takeaways.length === 3, r.blockers.join(' | '))
    check('generate: edits are method generate, one per field, ONE call', r.calls === 1 && r.edits.filter((e) => e.method === 'generate').length === 2 && r.edits.some((e) => e.field === 'faq') && r.edits.some((e) => e.field === 'key_takeaways'))
    check('generate: FAQ before and after are JSON', r.edits.find((e) => e.field === 'faq')?.before === '[]' && JSON.parse(r.edits.find((e) => e.field === 'faq')?.after ?? 'x').length === 4)

    const withNumber: ModelCall = async () => JSON.stringify({ faq: [1, 2, 3, 4].map((n) => ({ q: `Is Santorini question ${'abcd'[n - 1]}?`, a: `It has ${n * 100} villages.` })), key_takeaways: [] })
    const rn = await run(makeGuide({}, { faq: [] }), withNumber)
    check('generate: answers with a number that is not in the text are dropped', rn.fields.faq.length === 0 && rn.blockers.some((b) => /missing FAQ/.test(b)))
    const withSuper: ModelCall = async () => JSON.stringify({ faq: [1, 2, 3, 4].map((n) => ({ q: `Is Santorini question ${'abcd'[n - 1]}?`, a: 'It is the best island.' })) })
    const rsu = await run(makeGuide({}, { faq: [] }), withSuper)
    check('generate: answers that trip the superlative list are dropped', rsu.fields.faq.length === 0)

    // Missing share text is copied from the meta text with no model at all.
    const og = await run(makeGuide({}, { og_title: '', og_description: '' }), noModel)
    check('fixer: empty share text borrows the meta text, no model', og.fields.og_title.length > 0 && og.fields.og_description.length > 0 && og.calls === 0 || og.blockers.length === 0)
  }

  // -------------------------------------------------------------------------------------------------
  // 7. Plain-code fixers
  // -------------------------------------------------------------------------------------------------
  {
    const dash = makeGuide({ 1: [`Quiet lanes ${EM} and cafes ${EM} are easy to find.`] })
    const rd = await run(dash)
    check('fixer: long dashes become commas, no model', rd.blockers.length === 0 && !rd.fields.body.includes(EM) && rd.calls === 0 && rd.edits[0].method === 'fixer')
    const longMeta = makeGuide({}, { meta_description: `${'A plain guide to Santorini for groups '.repeat(6)}`.trim(), og_description: 'x '.repeat(80) })
    const rl = await repairContent(guideItem(longMeta), { model: noModel })
    // The guide gate does not check meta length; only page copy does. The fixer path is covered for page copy below.
    check('fixer: a guide with long meta text is not blocked by the guide gate', guideBlockers(longMeta, gateCtx).length === 0 && rl.edits.length === 0)
    const dead = makeGuide({ 2: ['Read [this page](/packages/not-real) for more.'] })
    const rdead = await run(dead)
    check('fixer: a dead link loses the link and keeps the words', rdead.blockers.length === 0 && rdead.fields.body.includes('Read this page for more.') && !rdead.fields.body.includes('not-real') && rdead.calls === 0)
    check('stripDeadLinks leaves a live link and the home page alone', stripDeadLinks('[a](/packages/x) [b](/) [c](/#contact) [d](/gone)', new Set(['/packages/x'])) === '[a](/packages/x) [b](/) [c](/#contact) d')
    const noLink = makeGuide({}, {})
    noLink.sections[0].body = noLink.sections[0].body.replace(' See [our trips](/packages/greek-isles).', '')
    noLink.body = noLink.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
    check('fixture: no internal link is blocked', guideBlockers(noLink, gateCtx).some((b) => /no internal link/.test(b)))
    const rn = await run(noLink)
    check('fixer: a page with no link gets a "Related" link to a real page, no model', rn.blockers.length === 0 && /Related: \[the "Greek Isles" trip\]\(\/packages\/greek-isles\)/.test(rn.fields.body) && rn.edits[0].field === 'links' && rn.calls === 0)
    check('addInternalLink returns null when every page is already linked', addInternalLink('[a](/packages/greek-isles)', [{ path: '/packages/greek-isles', label: 'x' }]) === null)
    const numbered = makeGuide({ 2: ['1. First thing to see.', '2. Second thing to see.'] })
    numbered.sections[2].body = `${para(16)}\n1. First thing to see.\n2. Second thing to see.`
    numbered.body = numbered.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
    const rnum = await run(numbered)
    check('fixer: a numbered list becomes bullets (list numbers count as numbers)', guideBlockers(numbered, gateCtx).some((b) => /number not in/.test(b)) && rnum.blockers.length === 0 && /- First thing to see\./.test(rnum.fields.body))
  }

  // -------------------------------------------------------------------------------------------------
  // 8. Posts and page copy
  // -------------------------------------------------------------------------------------------------
  {
    const goodBody = ['A river cruise is a relaxed way to see several towns without repacking.', '', '**Quick answer:** A river cruise suits first timers who want an easy pace.', '', '## Why a river cruise works for first timers', '', 'It is a floating hotel. See [the Rhine trip](/packages/rhine-cruise) for the real details. ' + 'word '.repeat(460), '', '### Pace', '', 'Most people find the pace gentle. It is easy to settle in. You unpack once.', '', 'Have a think about who you would travel with, and our team can help you work that out.'].join('\n')
    const good: ComposedPost = {
      title: 'River cruise for first timers',
      slug: 'river-cruise-for-first-timers',
      body: goodBody,
      seo_title: 'River cruise for first timers',
      seo_description: 'A plain guide for first-time river cruisers.',
      tags: ['river cruise first timers'],
      faq: [{ q: 'Is a river cruise good for first timers?', a: 'Yes, the pace is gentle.' }, { q: 'Do I unpack every day?', a: 'No, you unpack once.' }, { q: 'Who is it for?', a: 'Anyone who likes an easy pace.' }],
      key_takeaways: ['Gentle pace', 'Unpack once', 'Good for first timers'],
      og_title: 'Is a river cruise right for you?',
      og_description: 'A plain-English look at river cruising for first timers.',
      primary_keyword: 'river cruise first timers',
      secondary_keywords: ['river cruise tips'],
      content_style: 'faq-led',
    }
    const ctx = { allowedPaths: ['/packages/rhine-cruise'], groundingText: 'Rhine trip 2026-11-03 to 2026-11-10' }
    const now = new Date('2026-10-09T12:00:00Z')
    check('post fixture is clean', autoPublishBlockers(good, now, ctx).length === 0)

    const withNum: ComposedPost = { ...good, body: good.body.replace('You unpack once.', 'You unpack once. The ship holds 180 guests.') }
    const item = buildPostItem(withNum, now, ctx)
    const reword: ModelCall = async () => JSON.stringify({ rewrites: [{ id: 0, text: 'The ship holds guests.' }] })
    const r = await repairContent(item, { model: reword, maxCalls: 1 })
    check('post: a number is reworded with ONE call and the post gate is clean', r.blockers.length === 0 && r.calls === 1 && r.fields.body.includes('The ship holds guests.') && r.edits[0].method === 'ai', r.blockers.join(' | '))
    const stored = buildPostItem(withNum, now, ctx, { storedBody: (b) => `${b}\n\nCTA` })
    const rs = await repairContent(stored, { model: reword, maxCalls: 1 })
    check('post: the logged body is the stored body (call to action appended)', rs.edits[0].before.endsWith('\n\nCTA') && rs.edits[0].after.endsWith('\n\nCTA'))
    const rnm = await repairContent(item, { model: noModel, maxCalls: 1 })
    check('post: with no model answer the deterministic delete clears the number', rnm.blockers.length === 0 && !rnm.fields.body.includes('180'))
    const dead = buildPostItem({ ...good, body: good.body.replace('/packages/rhine-cruise', '/packages/nope') }, now, ctx)
    const rdead = await repairContent(dead, { model: noModel, maxCalls: 1 })
    check('post: a dead link is stripped with no model', rdead.blockers.length === 0 && rdead.calls === 0 && rdead.fields.body.includes('the Rhine trip') && !rdead.fields.body.includes('nope'))
    const ext = buildPostItem({ ...good, body: good.body + '\n\n[x](https://example.com)' }, now, ctx)
    const rext = await repairContent(ext, { model: noModel, maxCalls: 1 })
    check('post: an external link loses the link and keeps its words, no model', rext.hard.length === 0 && rext.blockers.length === 0 && rext.calls === 0 && rext.fields.body.includes('\n\nx') && !rext.fields.body.includes('example.com'), rext.blockers.join(' | '))
    const priceDel = buildPostItem({ ...good, body: good.body.replace('You unpack once.', 'You unpack once. Prices start from $1,200 per person.') }, now, ctx)
    const rpd = await repairContent(priceDel, { model: noModel, maxCalls: 1 })
    check('post: a price sentence inside a longer paragraph is deleted (Joel rule), not reworded', rpd.blockers.length === 0 && !rpd.fields.body.includes('1,200') && rpd.edits[0]?.method === 'delete', rpd.blockers.join(' | '))
    const price = buildPostItem({ ...good, body: good.body + '\n\nPrices start from $1,200 per person.' }, now, ctx)
    const rprice = await repairContent(price, { model: noModel, maxCalls: 1 })
    check('post: a price is HARD', rprice.edits.length === 0 && rprice.blockers.length > 0)
    const noFaq = buildPostItem({ ...good, faq: [], key_takeaways: [], skipped_enrich: true }, now, ctx)
    const fillFaq: ModelCall = async () => JSON.stringify({ faq: [{ q: 'Is a river cruise gentle?', a: 'Most people find the pace gentle.' }, { q: 'Do I unpack once?', a: 'You unpack once.' }, { q: 'Is it for first timers?', a: 'It is easy to settle in.' }], key_takeaways: ['Gentle pace', 'Unpack once', 'Easy to settle in'] })
    const rf = await repairContent(noFaq, { model: fillFaq, maxCalls: 1 })
    check('post: a skipped enrich step is regenerated from the body and the flag clears', rf.blockers.length === 0 && rf.fields.faq.length === 3, rf.blockers.join(' | '))
  }

  {
    const brief: PageCopyBrief = {
      type: 'compare',
      title: 'Italy vs Tahiti',
      destinations: [
        { name: 'Italy', slug: 'italy', blurb: null, guideSummary: null, packages: [{ name: 'Rome Highlights', slug: 'rome-highlights', destination: 'Italy', category: 'Cultural', short_description: 'A relaxed trip through the old town.', months: 'April to June' }] },
        { name: 'Tahiti', slug: 'tahiti', blurb: 'A string of islands in the South Pacific.', guideSummary: null, packages: [{ name: 'Tahiti Escape', slug: 'tahiti-escape', destination: 'Tahiti', category: 'Beach & Resort', short_description: null, months: 'September' }] },
      ],
      links: [
        { path: '/packages/rome-highlights', label: 'the "Rome Highlights" trip' },
        { path: '/packages/tahiti-escape', label: 'the "Tahiti Escape" trip' },
        { path: '/destinations/italy', label: 'our Italy page' },
        { path: '/destinations/tahiti', label: 'our Tahiti page' },
      ],
    }
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}`).join(' ')
    const copyCtx: CopyGateContext = { grounding: copyGroundingText(brief), destinations: ['Italy', 'Tahiti'], names: brief.links.map((l) => l.label), allowedPaths: new Set(brief.links.map((l) => l.path)) }
    const intro = `Italy and Tahiti suit different kinds of trips, and the trips we list for each show how. ${filler(150)} You can look at [the Rome Highlights trip](/packages/rome-highlights) for Italy or [our Tahiti page](/destinations/tahiti) for the islands.`
    const good: ComposedPageCopy = {
      intro,
      faq: [{ q: 'Which trips do you list for Italy?', a: 'We list the Rome Highlights trip right now.' }, { q: 'When does the Tahiti Escape run?', a: 'It runs in September.' }, { q: 'Can I see both on one page?', a: 'Yes, the trips for both destinations are listed below.' }],
      key_takeaways: ['Italy and Tahiti suit different trips.', 'Each trip below is one we list now.', 'Ask us if you want help choosing.'],
      meta_title: 'Italy vs Tahiti Trips',
      meta_description: 'See the real Italy and Tahiti trips we list side by side.',
      og_title: 'Italy or Tahiti? See the trips',
      og_description: 'Two destinations, two kinds of trip.',
      primary_keyword: 'italy vs tahiti trips',
    }
    check('page copy fixture is clean', pageCopyBlockers(good, copyCtx).length === 0, pageCopyBlockers(good, copyCtx).join(' | '))
    const weather = { ...good, intro: intro.replace('for the islands.', 'for the islands. The weather is warm in spring.') }
    check('page copy: the weather sentence is blocked', pageCopyBlockers(weather, copyCtx).some((b) => /weather/.test(b)))
    const rw = await repairContent(buildCopyItem(weather, copyCtx, { path: '/compare/italy-vs-tahiti', links: brief.links }), { model: noModel })
    check('page copy: the weather sentence is deleted (the paragraph keeps 2+ sentences) and the gate is clean', rw.blockers.length === 0 && !rw.fields.body.includes('weather'), rw.blockers.join(' | '))
    const verdict = { ...good, intro: intro.replace('for the islands.', 'for the islands. Italy is better than Tahiti for history.') }
    check('page copy: a verdict is blocked', pageCopyBlockers(verdict, copyCtx).some((b) => /verdict|better/.test(b)))
    const rv = await repairContent(buildCopyItem(verdict, copyCtx, { path: '/compare/italy-vs-tahiti', links: brief.links }), { model: noModel })
    check('page copy: a verdict sentence is removed', rv.blockers.length === 0 && !rv.fields.body.includes('better than'), rv.blockers.join(' | '))
    const longMeta = { ...good, meta_title: 'Italy vs Tahiti: the trips we list side by side now', og_title: 'x'.repeat(70) }
    const rm = await repairContent(buildCopyItem(longMeta, copyCtx, { path: '/compare/italy-vs-tahiti', links: brief.links }), { model: noModel })
    check('page copy: over-long meta and share text are cut at a word with no model', rm.blockers.length === 0 && rm.calls === 0 && rm.fields.meta_title.length <= 42 && rm.fields.og_title.length <= 60)
    const manyLinks = { ...good, intro: `${intro} Also [a](/destinations/italy) and [b](/packages/tahiti-escape).` }
    const rml = await repairContent(buildCopyItem(manyLinks, copyCtx, { path: '/compare/italy-vs-tahiti', links: brief.links }), { model: noModel })
    check('page copy: more than three links are trimmed to three', pageCopyBlockers(manyLinks, copyCtx).some((b) => /at most 3/.test(b)) && rml.blockers.length === 0)
  }

  // -------------------------------------------------------------------------------------------------
  // 9. SEO score
  // -------------------------------------------------------------------------------------------------
  {
    const g = makeGuide()
    const existing = new Set(['/', '/packages', '/packages/greek-isles'])
    const goodScore = seoScore({
      title: g.meta_title,
      metaDescription: g.meta_description,
      ogTitle: g.og_title,
      ogDescription: g.og_description,
      body: `${g.summary}\n\n${g.body}`,
      faq: g.faq,
      takeaways: g.key_takeaways,
      primaryKeyword: g.primary_keyword,
      targetWords: { min: 1200, max: 1800 },
      hasImageAlt: true,
      existingPaths: existing,
      jsonLdTypes: ['Article', 'BreadcrumbList', 'FAQPage'],
    })
    check('seo: a good page scores 95+ with no reasons', goodScore.score >= 95 && goodScore.reasons.length === 0, `${goodScore.score} ${goodScore.reasons.join(' | ')}`)
    const badBody = `# Title again\n\nA long dash ${EM} here. ${'This sentence is intentionally very long and keeps going on and on without any real stopping point so that the average sentence length is far above the limit ' .repeat(2)}[ghost](/packages/ghost)`
    const bad = seoScore({ title: 'Hi', metaDescription: '', ogTitle: '', ogDescription: '', body: badBody, faq: [], takeaways: ['one'], primaryKeyword: 'santorini island', targetWords: { min: 1200, max: 1800 }, hasImageAlt: false, existingPaths: existing, jsonLdTypes: ['Article'] })
    check('seo: a bad page scores under 40', bad.score < 40, String(bad.score))
    const want: [string, RegExp][] = [
      ['short title', /title is 2 characters/],
      ['keyword missing from title', /does not contain the primary keyword/],
      ['no meta description', /no meta description/],
      ['share text missing', /social share title and description are missing/],
      ['two H1s', /2 H1 headings/],
      ['keyword not early', /not in the first 100 words/],
      ['too few H2s', /0 H2 section headings/],
      ['too short', /words; this kind of page aims for 1200 to 1800/],
      ['FAQ short', /FAQ has 0 questions/],
      ['takeaways short', /1 key takeaway;/],
      ['dead link', /links to 1 page that does not exist: \/packages\/ghost/],
      ['no image alt', /no picture with alt text/],
      ['structured data', /does not emit these structured data types: FAQPage/],
      ['dash', /long dash/],
      ['readability', /Sentences average \d+ words/],
    ]
    for (const [label, re] of want) check(`seo reason: ${label}`, bad.reasons.some((r) => re.test(r)), bad.reasons.join(' | '))
    check('seo: failed ids drive the fixers', bad.failed.includes('meta-description') && bad.failed.includes('dashes') && bad.failed.includes('dead-links') && bad.failed.includes('og'))
    const noH2 = seoScore({ title: 'Italy vs Tahiti Trips', titleRange: [20, 60], metaDescription: 'See the real Italy and Tahiti trips we list side by side right now, in one place.', ogTitle: 'a', ogDescription: 'b', body: 'Italy and Tahiti trips are listed here. See [x](/packages/greek-isles).', faq: [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }, { q: 'e', a: 'f' }], takeaways: ['1', '2', '3'], primaryKeyword: 'italy tahiti trips', targetWords: { min: 1, max: 5000 }, hasImageAlt: false, imageApplies: false, expectH2: false, existingPaths: existing, jsonLdTypes: ['CollectionPage', 'BreadcrumbList', 'FAQPage'], jsonLdExpected: ['CollectionPage', 'FAQPage', 'BreadcrumbList'] })
    check('seo: checks that do not apply (H2s, image) do not cost a page-copy intro points', noH2.score >= 95, `${noH2.score} ${noH2.reasons.join(' | ')}`)
    check('internalLinkPathsOf normalises paths', internalLinkPathsOf('[a](/packages/x/) [b](/#contact) [c](/blog/y?utm=1) [d](https://example.com)').join(',') === '/packages/x,/,/blog/y')
  }

  // -------------------------------------------------------------------------------------------------
  // 10. The cheap (no-model) heal fixes
  // -------------------------------------------------------------------------------------------------
  {
    const dest = { path: '/destinations/santorini', title: 'Santorini', dest: 'santorini', rank: 0 }
    const best = { path: '/best-time-to-visit/santorini', title: 'the best time to visit Santorini', dest: 'santorini', rank: 2 }
    const other = { path: '/destinations/rome', title: 'Rome', dest: 'rome', rank: 0 }
    const existing = new Set(['/', '/destinations/santorini', '/best-time-to-visit/santorini', '/destinations/rome'])
    const fields: RepairFields = {
      title: 'Santorini island guide',
      body: `Plan a trip to Santorini ${EM} it is easy.\n\n## Where to stay\n\nSantorini has lanes and cafes. Read [this](/packages/ghost) too.`,
      meta_title: 'Santorini island guide',
      meta_description: `${'A plain guide to Santorini for groups. '.repeat(8)}`.trim(),
      og_title: '',
      og_description: '',
      faq: [],
      key_takeaways: [],
    }
    const plan = planCheapFixes({ type: 'post', path: '/blog/x', fields, limits: { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }, destSlugs: ['santorini'] }, ['dashes', 'meta-description', 'og', 'internal-link', 'dead-links', 'faq', 'takeaways'], existing, [dest, best, other])
    check('heal: dashes are removed', !plan.fields.body.includes(EM))
    check('heal: over-long meta text is cut at a word, within 155', plan.fields.meta_description.length <= 155 && plan.fields.meta_description.length > 100 && !/\s$/.test(plan.fields.meta_description))
    check('heal: share text is copied from the meta text', plan.fields.og_title === 'Santorini island guide' && plan.fields.og_description.length > 0 && plan.fields.og_description.length <= 110)
    check('heal: a dead link loses the link and keeps the words', plan.fields.body.includes('Read this too.') && !plan.fields.body.includes('ghost'))
    check('heal: an existing mention becomes a link to a page about the SAME destination', plan.fields.body.includes('[Santorini](/destinations/santorini)') && !plan.fields.body.includes('/destinations/rome'))
    check('heal: only the first mention is linked', (plan.fields.body.match(/\]\(\/destinations\/santorini\)/g) ?? []).length === 1)
    check('heal: the model is asked for what is still missing (FAQ, takeaways), not for the body', plan.generate.includes('faq') && plan.generate.includes('key_takeaways') && !plan.generate.includes('meta_description'))
    const noStrip = planCheapFixes({ type: 'post', path: '/blog/x', fields, limits: { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }, destSlugs: ['santorini'] }, ['dead-links'], existing, [dest], { stripDead: false })
    check('heal: with an incomplete site index no link is stripped', noStrip.fields.body.includes('[this](/packages/ghost)'))
    const guardTitle = planCheapFixes({ type: 'guide', path: '/hotels/x', fields: { ...fields, title: `Title ${EM} one`, summary: `Opening ${EM} line.` }, limits: { faqMin: 4, faqMax: 6, takeMin: 3, takeMax: 5, metaTitleMax: 60, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110 }, destSlugs: [] }, ['dashes'], existing, [])
    check('heal: a title and a guide summary are never changed by a fixer', guardTitle.fields.title === `Title ${EM} one` && guardTitle.fields.summary === `Opening ${EM} line.` && !guardTitle.fields.body.includes(EM))
    check('heal: edits are tracked with the right methods', plan.tracker.methods.get('body')?.has('links') === true && plan.tracker.methods.get('body')?.has('fixer') === true)
    const words = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).join(' ')
    check('heal: the words of the body are unchanged apart from the dash and the dead link target', words(plan.fields.body).replace(/\bRelated\b.*$/, '').length > 0 && words(plan.fields.body).includes('Plan a trip to Santorini it is easy'))
    const noMention = addRelatedLinks('A page that never names the place.', [dest, best], 2)
    check('heal: with no mention a single "Related" line is appended', /\n\nRelated: \[Santorini\]\(\/destinations\/santorini\), \[the best time to visit Santorini\]\(\/best-time-to-visit\/santorini\)\.$/.test(noMention.body) && noMention.added.length === 2)
    check('heal: a heading and an existing link are never turned into a link', linkFirstMention('## Santorini\n\n[Santorini guide](/x) text', 'Santorini', '/destinations/santorini') === null)
    const pc = planCheapFixes({ type: 'page_copy', path: '/compare/a-vs-b', fields: { ...fields, body: 'Plain intro with Santorini named.', title: undefined }, limits: { faqMin: 3, faqMax: 5, takeMin: 3, takeMax: 5, metaTitleMax: 42, metaDescMax: 155, ogTitleMax: 60, ogDescMax: 110, maxBodyLinks: 3 }, destSlugs: ['santorini'] }, ['internal-link'], existing, [dest, { path: '/packages/trip', title: 'Trip', dest: 'santorini', rank: 3 }])
    check('heal: page copy never gets a package link from the heal', !pc.fields.body.includes('/packages/'))
    check('mergeFaq keeps what is there and skips repeated questions', mergeFaq([{ q: 'Is it easy?', a: 'x' }], [{ q: 'is it easy', a: 'y' }, { q: 'Is it near?', a: 'z' }], 5).length === 2)
  }

  // -------------------------------------------------------------------------------------------------
  // 11. Slots, "log then apply", revert helpers
  // -------------------------------------------------------------------------------------------------
  {
    const world = fakeAdmin()
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => claimRepairSlot(world.admin, `item-${i}`)))
    check(`slots: at most ${REPAIR_ITEMS_PER_DAY} pages get a slot per day, even when claimed at once`, results.filter((r) => r.ok).length === REPAIR_ITEMS_PER_DAY, String(results.filter((r) => r.ok).length))
    const again = await claimRepairSlot(world.admin, 'item-0')
    const winner = results.findIndex((r) => r.ok)
    check('slots: a page that already has a slot keeps it', (await claimRepairSlot(world.admin, `item-${winner}`)).ok === true && again !== undefined)
    check('slots: the 7th page is refused with a reason', results.some((r) => !r.ok && /cap of 6/.test(r.reason ?? '')))
    check('once-a-day marker: first claim wins, the second is refused', (await claimDailyOnce(world.admin, 'post:abc')) === true && (await claimDailyOnce(world.admin, 'post:abc')) === false && (await claimDailyOnce(world.admin, 'post:def')) === true)
    const brokenSlots = fakeAdmin({ settingsError: true })
    check('slots fail closed when they cannot be read', (await claimRepairSlot(brokenSlots.admin, 'x')).ok === false)

    // Repair end to end (fake database): audit rows are written, a HARD item takes no slot.
    const w2 = fakeAdmin()
    const bad = makeGuide({ 1: ['The harbour is the best place to eat.'] })
    const out = await repairComposedGuide(w2.admin, bad, gateCtx, { kind: 'destinations', slug: 'santorini', path: '/destinations/santorini', links, model: noModel })
    check('wrapper: repaired, clean, audit rows written before use', out.blockers.length === 0 && out.logIds.length === 1 && w2.edits.length === 1 && w2.edits[0].content_id === null && w2.edits[0].path === '/destinations/santorini')
    check('wrapper: one slot taken and the spend estimate recorded', w2.settings.filter((s) => s.key.startsWith('content_repair_slot:')).length === 1 && w2.settings.some((s) => s.key.startsWith('content_repair_spend:')))
    const w3 = fakeAdmin()
    const hard = await repairComposedGuide(w3.admin, makeGuide({ 1: ['When I visited last year it was calm.'] }), gateCtx, { kind: 'destinations', slug: 'santorini', path: '/destinations/santorini', links, model: noModel })
    check('wrapper: a HARD guide takes no slot, writes no edit, stays blocked', hard.logIds.length === 0 && w3.edits.length === 0 && w3.settings.length === 0 && hard.blockers.length > 0)
    const w4 = fakeAdmin({ editsInsertError: true })
    const failedLog = await repairComposedGuide(w4.admin, bad, gateCtx, { kind: 'destinations', slug: 'santorini', path: '/destinations/santorini', links, model: noModel })
    check('wrapper: if the audit log cannot be written nothing is repaired (blocked as before)', failedLog.value === bad && failedLog.blockers.some((b) => /superlative/.test(b)) && /audit log/.test(failedLog.note))
    const w5 = fakeAdmin({ noEditsTable: true })
    const noTable = await repairComposedGuide(w5.admin, bad, gateCtx, { kind: 'destinations', slug: 'santorini', path: '/destinations/santorini', links, model: noModel })
    check('wrapper: without migration 0033 nothing is repaired', noTable.value === bad && /0033/.test(noTable.note) && w5.settings.length === 0)

    // Revert helpers: the log stores what the row holds, and `before` can be put back.
    const g = makeGuide()
    const fields = guideFields(g)
    const row = { summary: g.summary, body: g.body, sections: g.sections, faq: g.faq, key_takeaways: g.key_takeaways, meta_title: g.meta_title }
    check('revert: storedValue matches the audit text for a guide body, faq and takeaways', storedValue('guide', row, 'body') === serializeField('guide', fields, 'body') && storedValue('guide', row, 'faq') === serializeField('guide', fields, 'faq') && storedValue('guide', row, 'key_takeaways') === serializeField('guide', fields, 'key_takeaways'))
    const back = columnsFor('guide', 'body', serializeField('guide', fields, 'body')) as { summary: string; body: string; sections: unknown[] } | null
    check('revert: a guide body is split back into summary, body and sections', !!back && back.summary === g.summary && back.body === g.body && back.sections.length === 8)
    check('revert: faq and takeaways come back from JSON; a title only exists on posts', JSON.stringify(columnsFor('guide', 'faq', '[{"q":"a","a":"b"}]')) === '{"faq":[{"q":"a","a":"b"}]}' && columnsFor('guide', 'title', 'x') === null && JSON.stringify(columnsFor('post', 'title', 'x')) === '{"title":"x"}' && columnsFor('guide', 'faq', 'not json') === null)
    check('revert: page copy restores its intro and recomputes the trips it links to', JSON.stringify(columnsFor('page_copy', 'links', 'See [a](/packages/rome-highlights).')) === '{"intro":"See [a](/packages/rome-highlights).","linked_slugs":["rome-highlights"]}')
  }

  // -------------------------------------------------------------------------------------------------
  // 12. Publish rule
  // -------------------------------------------------------------------------------------------------
  {
    check('publish: draft mode still holds a clean guide', !publishDecision('hotels', 'draft', 'pipeline', []).publish)
    check('publish: blockers always hold it, whatever the kind', !publishDecision('resorts', 'publish', 'pipeline', ['superlative or rating claim (best)']).publish)
    for (const k of ['destinations', 'cruise-lines', 'hotels', 'resorts', 'ships', 'river-cruises', 'yachts'] as const) check(`publish: a clean ${k} guide goes live in publish mode`, publishDecision(k, 'publish', 'pipeline', []).publish)
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
})()

// ---------------------------------------------------------------------------------------------------
// A tiny in-memory stand-in for the Supabase client: app_settings and content_edits only.
// ---------------------------------------------------------------------------------------------------
function fakeAdmin(flags: { settingsError?: boolean; editsInsertError?: boolean; noEditsTable?: boolean } = {}) {
  const settings: { key: string; value: string }[] = []
  const edits: Record<string, unknown>[] = []
  let nextId = 1
  const admin = {
    from(table: string) {
      if (table === 'app_settings') {
        return {
          select() {
            return {
              like(_col: string, pattern: string) {
                if (flags.settingsError) return Promise.resolve({ data: null, error: { message: 'boom' } })
                const prefix = pattern.replace(/%$/, '')
                return Promise.resolve({ data: settings.filter((s) => s.key.startsWith(prefix)), error: null })
              },
              eq(_c: string, key: string) {
                return { maybeSingle: () => Promise.resolve({ data: settings.find((s) => s.key === key) ?? null, error: null }) }
              },
            }
          },
          insert(row: { key: string; value: string }) {
            if (settings.some((s) => s.key === row.key)) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } })
            settings.push({ key: row.key, value: row.value })
            return Promise.resolve({ error: null })
          },
          upsert(row: { key: string; value: string }) {
            const i = settings.findIndex((s) => s.key === row.key)
            if (i >= 0) settings[i] = { key: row.key, value: row.value }
            else settings.push({ key: row.key, value: row.value })
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'content_edits') {
        return {
          select() {
            return { limit: () => Promise.resolve({ data: [], error: flags.noEditsTable ? { message: 'relation does not exist' } : null }) }
          },
          insert(rows: Record<string, unknown>[]) {
            const insertResult = flags.editsInsertError ? { data: null, error: { message: 'insert failed' } } : null
            const stamped = rows.map((r) => ({ ...r, id: `edit-${nextId++}` }))
            if (!insertResult) edits.push(...stamped)
            return { select: () => Promise.resolve(insertResult ?? { data: stamped.map((r) => ({ id: r.id })), error: null }) }
          },
          delete() {
            return { in: (_c: string, ids: string[]) => { for (const id of ids) { const i = edits.findIndex((e) => e.id === id); if (i >= 0) edits.splice(i, 1) } return Promise.resolve({ error: null }) } }
          },
        }
      }
      throw new Error(`fake admin: unexpected table ${table}`)
    },
  }
  return { admin: admin as never, settings, edits }
}
