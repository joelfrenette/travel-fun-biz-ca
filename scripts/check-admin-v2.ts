// Offline check for Admin v2: the numbered, sectioned menu, the automated system check, the Daily follow-ups and the Today polish.
// Run: pnpm dlx tsx scripts/check-admin-v2.ts   (exit 1 on a failure)
// The wording of the system check is proved separately in scripts/check-system-check-voice.ts.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SETUP_STEPS_URL, adminNavItems, adminNavLinks, adminNavSections, adminTools, numberSections, stepOf, type NavSection,
} from '../lib/admin-nav'
import {
  DAYS_KEPT, DAY_BUCKET_MAX, FOLLOWUP_CAP, PERSIST_BUCKET, PERSIST_MAX, SETUP_AT_ONCE, SETUP_FOLLOWUPS, allCandidates, applyMark, boundDone, briefFollowups, daysBetween, isFollowId, leadCandidates, leadStep,
  listIsFresh, markOf, openCountFrom, parseDone, parseList, selectFollowups, serializeDone, serializeList, setupCandidates, siteDay, slug, weeklyCandidates,
  type DoneState, type FollowSources, type LeadFact,
} from '../lib/followups'
import {
  STAGE_IDS, SYSTEM_CHECK_TTL_MS, checkBriefLines, evaluateCheck, fixedByStage, isFresh, parseCheck, serializeCheck, stageOfDecision, summarizeCheck, unreadFacts, worstLight, type CheckFacts, type DecisionLike,
} from '../lib/system-check'
import { buildFixList, fixIdOf, stageOfFixId, summarizeFixes, topOpenFixes, withMarks } from '../lib/system-check-fixes'
import { TODAY_KINDS, TODAY_KIND_IDS, actionFor, needsConfirm, parseCardId } from '../lib/today-cards'
import { briefHtml } from '../lib/brief-html'
import type { Brief } from '../lib/debrief'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const DASH = /[—–]/

// =================================================================================================
// 1. The numbered, sectioned menu
// =================================================================================================
const SECTION_ORDER = ['do-first', 'live', 'make', 'grow', 'money', 'advanced', 'setup']
expect('the sections are in the order of the day', adminNavSections.map((s) => s.id).join(',') === SECTION_ORDER.join(','), adminNavSections.map((s) => s.id).join(','))
expect('the section names are Do first, Live numbers, Make and post, Grow, Money, Advanced, Setup', adminNavSections.map((s) => s.title).join('|') === 'Do first|Live numbers|Make and post|Grow|Money|Advanced|Setup')

const WORKFLOW = [
  'System check', 'Today', 'Daily follow-ups', 'Dashboard',
  'Search Rankings', 'Users and Analytics', 'Website Value',
  'Posts: Blog', 'Posts: News', 'Posts: Guides', 'Posts: Trips', 'Content Autopilot', 'Post Distribution',
  'SEO & GEO Manager', 'SEO engines', 'Keyword Research', 'Link building',
  'Leads', 'Travel Agents', 'Orders', 'Affiliate Links', 'Testimonials',
]
const numbered = adminNavLinks.filter((l) => l.step !== null)
expect('the daily links are exactly the 22 steps, in workflow order', numbered.map((l) => l.title).join('|') === WORKFLOW.join('|'), numbered.map((l) => l.title).join('|'))
expect('the step numbers are contiguous from 1 to 22 in menu order', numbered.map((l) => l.step).join(',') === Array.from({ length: 22 }, (_, i) => i + 1).join(','), numbered.map((l) => l.step).join(','))
expect('the number is drawn from the data: moving a link moves its number', (() => {
  const swapped: NavSection[] = adminNavSections.slice(0, 1).map((s) => ({ ...s, links: [s.links[1], s.links[0], s.links[2], s.links[3]] }))
  const n = numberSections(swapped)[0].links
  return n[0].title === 'Today' && n[0].step === 1 && n[1].title === 'System check' && n[1].step === 2
})())
expect('System check is step 1, Today 2, Daily follow-ups 3, Dashboard 4', stepOf('System check') === 1 && stepOf('Today') === 2 && stepOf('Daily follow-ups') === 3 && stepOf('Dashboard') === 4)
expect('stepOf finds a link by key', stepOf('Today') === 2 && stepOf('Link building') === 17 && stepOf('Testimonials') === 22 && stepOf('Posts: Blog Auto-Writer') === null)
expect('System check, Today and Daily follow-ups carry the three badges, in that order', adminNavLinks[0].badge === 'check' && adminNavLinks[1].badge === 'today' && adminNavLinks[2].badge === 'followups' && adminNavLinks.filter((l) => l.badge).length === 3)
expect('Do first links go to /admin/system-check, /admin, /admin/follow-ups and /admin/dashboard', adminNavLinks[0].href === '/admin/system-check' && adminNavLinks[1].href === '/admin' && adminNavLinks[2].href === '/admin/follow-ups' && adminNavLinks[3].href === '/admin/dashboard')

const byId = (id: string) => adminNavSections.find((s) => s.id === id)!
expect('Advanced and Setup are collapsed by default; the five daily sections are open', !byId('advanced').defaultOpen && !byId('setup').defaultOpen && ['do-first', 'live', 'make', 'grow', 'money'].every((id) => byId(id).defaultOpen))
expect('Advanced and Setup have no step numbers', [...byId('advanced').links, ...byId('setup').links].every((l) => l.step === null) && adminNavSections.filter((s) => s.numbered).map((s) => s.id).join(',') === 'do-first,live,make,grow,money')
expect('Advanced holds Blog Auto-Writer, Project Tracker, System Health and Content edits', byId('advanced').links.map((l) => l.title).join('|') === 'Posts: Blog Auto-Writer|Project Tracker|System Health|Content edits')
const later = byId('advanced').later ?? []
expect('everything not built yet is one Later sub-list inside Advanced (no link, Coming Soon)', later.length > 0 && later.every((l) => l.status === 'Coming Soon' && l.href === null) && adminNavSections.filter((s) => s.id !== 'advanced').every((s) => !s.later))
expect('Setup links to the setup checklist (SETUP_STEPS_URL, new tab) and the link building tasks', byId('setup').links[0].href === SETUP_STEPS_URL && byId('setup').links[0].external === true && byId('setup').links[1].title === 'Link building tasks' && byId('setup').links[1].href === '/admin/links-building' && byId('setup').links[1].shortcut === true)
expect('SETUP_STEPS_URL is the one checklist link and the dashboard imports it instead of its own copy', /claude\.ai\/artifact\/PN6caspQe9V6RUUsJ2vNcw/.test(SETUP_STEPS_URL) && /SETUP_STEPS_URL \} from "@\/lib\/admin-nav"/.test(read('app/admin/dashboard/page.tsx')) && !/const SETUP_STEPS_URL/.test(read('app/admin/dashboard/page.tsx')))

const modules = adminNavItems.slice(1).map((i) => i.title) // adminNavItems[0] is the old Dashboard entry
const placed = [...adminNavSections.flatMap((s) => s.links.filter((l) => !l.shortcut && l.title !== 'Today' && l.title !== 'Dashboard' && !l.external)), ...later].map((l) => l.title)
expect('every old module appears in the menu', modules.every((t) => placed.includes(t)), modules.filter((t) => !placed.includes(t)).join(','))
expect('every module appears exactly once (the Setup shortcut is not a second module)', placed.length === new Set(placed).size && placed.length === modules.length, `${placed.length} placed, ${modules.length} modules, doubled: ${placed.filter((t, i) => placed.indexOf(t) !== i).join(',')}`)
expect('no URL was renamed: every module keeps its old link', placed.every((t) => { const link = [...adminNavSections.flatMap((s) => s.links), ...later].find((l) => l.title === t && !l.shortcut)!; return adminNavItems.some((o) => o.title === t && o.href === link.href) }))
expect('the dashboard grid and the older checks still get the flat lists', adminTools.length === modules.length && /export const adminNavItems/.test(read('lib/admin-nav.ts')) && /export const adminTools/.test(read('lib/admin-nav.ts')))
expect('the three new modules are real pages', ['app/admin/follow-ups/page.tsx', 'app/admin/system-check/page.tsx', 'app/admin/content-edits/page.tsx'].every((f) => existsSync(join(process.cwd(), f))))
expect('no long dash in a menu title, hint or description', adminNavSections.every((s) => !DASH.test(s.title + s.hint + s.links.map((l) => l.title + l.description).join('') + (s.later ?? []).map((l) => l.title + l.description).join(''))))

const shell = read('components/admin/admin-shell.tsx')
expect('the menu draws the step number from the data', /link\.step !== null/.test(shell) && /\{link\.step\}/.test(shell) && /\(step \{link\.step\}\)/.test(shell))
expect('section headers are collapsible buttons with aria-expanded, and the state is remembered inside try/catch', /aria-expanded=\{isOpen\}/.test(shell) && /adminNavOpen/.test(shell) && /try \{\s*localStorage\.setItem\(OPEN_KEY/.test(shell) && /try \{\s*const v = JSON\.parse\(localStorage\.getItem\(OPEN_KEY/.test(shell))
expect('the active link is highlighted and marked with aria-current', /aria-current=\{active \? "page" : undefined\}/.test(shell) && /bg-primary\/10 text-primary/.test(shell))
expect('a section with the open page in it opens by itself even when collapsed by default', /open\[section\.id\] \?\? \(section\.defaultOpen \|\| hasActive\)/.test(shell))
expect('the badge counts come from ONE fetch of the queue (the shell calls fetchToday once, pages only announce)', (shell.match(/fetchToday\(/g) ?? []).length === 1 && /readCachedBadges\(\)/.test(shell) && /BADGES_EVENT/.test(shell))
const client = read('components/admin/today-client.ts')
expect('the shared client keeps one request in flight and caches the answer briefly', /inflight/.test(client) && /FRESH_MS/.test(client) && /export function announceBadges/.test(client) && (client.match(/fetch\(/g) ?? []).length === 1)
expect('the phone bottom bar is Check, Today, Follow-ups, Menu, in that order, plus the drawer', (() => {
  const a = shell.indexOf('label="Check"'), b = shell.indexOf('label="Today"'), c = shell.indexOf('label="Follow-ups"'), d = shell.indexOf('Open the full menu')
  return a > 0 && a < b && b < c && c < d && /aria-label="Quick links"/.test(shell) && /grid-cols-4/.test(shell) && /role="dialog"/.test(shell) && /md:hidden/.test(shell)
})())
expect('the phone bar links go to the right pages', /href="\/admin\/follow-ups"/.test(shell) && /href="\/admin\/system-check"/.test(shell) && /href="\/admin" label="Today"/.test(shell))
expect('the system check dot is announced in words as well as colour', /System check: \$\{CHECK_WORD/.test(shell))

// =================================================================================================
// 2. Daily follow-ups
// =================================================================================================
const MON = new Date('2026-10-26T15:00:00Z') // a Monday in Toronto
const TUE = new Date('2026-10-27T15:00:00Z')
const FRI = new Date('2026-10-30T15:00:00Z')
const SAT = new Date('2026-10-24T15:00:00Z')
const lead = (id: string, daysAgo: number, now: Date, extra: Partial<LeadFact> = {}): LeadFact => ({ id, name: `Lead ${id}`, email: `${id}@example.com`, phone: '555-0100', createdAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(), ...extra })
const seoFix = (id: string, impact: number, effort = 1) => ({ id, title: `Fix ${id}`, why: 'It matters.', hint: `Open the page and fix ${id}.`, impact, effort, href: `/admin/seo-manager#${id}` })

function sources(now: Date, over: Partial<FollowSources> = {}): FollowSources {
  return {
    now,
    digestActions: ['Write about the 3 searches that grew', 'Share the top post again', 'Reply to the 2 new comments'],
    seoFixes: [seoFix('a', 5), seoFix('b', 4, 2), seoFix('c', 4, 3)],
    leads: [lead('L1', 0, now), lead('L2', 3, now), lead('L3', 7, now), lead('L4', 9, now)],
    repliedLeadIds: [],
    linkTasks: [{ id: 'bing-places', title: 'Bing Places for Business', how: 'x', effort: 'low' }, { id: 'apple-business-connect', title: 'Apple Business Connect', how: 'x', effort: 'low' }, { id: 'third', title: 'Third', how: 'x', effort: 'high' }],
    recaps: [{ id: 'r1', name: 'Alps trip', href: '/admin/packages/r1/recap' }, { id: 'r2', name: 'Fiji trip', href: '/admin/packages/r2/recap' }, { id: 'r3', name: 'Third trip', href: '/x' }],
    done: {},
    ...over,
  }
}

const monday = selectFollowups(allCandidates(sources(MON)), {}, MON)
expect('the daily list is capped at 8 items', monday.items.length === FOLLOWUP_CAP && FOLLOWUP_CAP === 8, String(monday.items.length))
expect('there are more candidates than the cap, so the cap really cuts', allCandidates(sources(MON)).length > FOLLOWUP_CAP, String(allCandidates(sources(MON)).length))
expect('the list is ordered by impact, best first, and a lead who just wrote in is on top', monday.items.every((it, i, a) => i === 0 || a[i - 1].impact >= it.impact) && monday.items[0].group === 'lead' && /^lead:L1:d0$/.test(monday.items[0].id), monday.items.map((i) => i.id).join(','))
expect('the lowest impact items (setup steps, recaps) are the ones cut when the day is full', !monday.items.some((i) => i.group === 'setup') && allCandidates(sources(MON)).some((i) => i.group === 'setup'))
expect('every item has a reason, a time guess and a link to open', monday.items.every((i) => i.why.length > 10 && i.minutes > 0 && i.minutes <= 60 && (i.href.startsWith('/') || i.href.startsWith('https://'))), monday.items.filter((i) => !(i.why.length > 10 && i.minutes > 0 && i.minutes <= 60 && (i.href.startsWith('/') || i.href.startsWith('https://')))).map((i) => JSON.stringify(i)).join(' | '))
expect('every id is a safe stored id', allCandidates(sources(MON)).every((i) => isFollowId(i.id)), allCandidates(sources(MON)).filter((i) => !isFollowId(i.id)).map((i) => i.id).join(','))
expect('every group is reachable: digest, seo, lead, social, weekly, links, recap, setup', (() => {
  const g = new Set(allCandidates(sources(MON)).map((i) => i.group))
  return ['digest', 'seo', 'lead', 'social', 'weekly', 'links', 'recap', 'setup'].every((x) => g.has(x as never))
})())

// weekday items
expect('Monday has the Search Console review and no Friday item', weeklyCandidates(MON).map((i) => i.title).join('|') === 'Review Search Console')
expect('Friday has the grid check and no Monday item', weeklyCandidates(FRI).map((i) => i.title).join('|') === 'Check the grid and tell Claude what you liked')
expect('Tuesday and Saturday have no weekly item', weeklyCandidates(TUE).length === 0 && weeklyCandidates(SAT).length === 0)
expect('the social routine is a standing item every day', [MON, TUE, FRI, SAT].every((d) => allCandidates(sources(d)).some((i) => i.id === 'social:routine' && i.minutes === 15)))

// leads
expect('a lead step follows the age: day 0 and 1 call or text, 2 to 4 email, 5 to 14 last nudge, then nothing', leadStep(0) === 'd0' && leadStep(1) === 'd0' && leadStep(2) === 'd2' && leadStep(4) === 'd2' && leadStep(5) === 'd5' && leadStep(14) === 'd5' && leadStep(15) === null)
const ls = leadCandidates([lead('N', 0, MON), lead('M', 3, MON), lead('O', 6, MON), lead('P', 20, MON), lead('Q', 1, MON, { phone: '' })], [], MON)
expect('leads are newest first, at most 3, and too old ones are dropped', ls.length === 3 && ls.map((i) => i.id).join(',') === 'lead:N:d0,lead:Q:d0,lead:M:d2', ls.map((i) => i.id).join(','))
expect('day 0 says call or text (or email when there is no phone); day 2 says email; day 5 says last nudge', /^Call or text Lead N$/.test(ls[0].title) && /^Email Lead Q$/.test(ls[1].title) && /^Email Lead M$/.test(ls[2].title) && /last friendly nudge/.test(leadCandidates([lead('O', 6, MON)], [], MON)[0].title))
expect('each lead item shows its age', ls[0].note === 'Came in today' && ls[1].note === 'Came in yesterday' && ls[2].note === 'Came in 3 days ago')
expect('a lead already answered on Today never appears', leadCandidates([lead('N', 0, MON)], ['N'], MON).length === 0)
expect('age counts site days: late evening and early morning are one day apart', daysBetween('2026-10-24T03:30:00Z', new Date('2026-10-24T05:00:00Z')) === 1 && daysBetween('2026-10-25T14:00:00Z', new Date('2026-10-25T20:00:00Z')) === 0)
expect('lead items are kept for good once ticked, so the same step never comes back', ls.every((i) => i.persist))

// ticks per day
const doneMon = applyMark({}, siteDay(MON), monday.items[3], 'done')
const selMon = selectFollowups(allCandidates(sources(MON)), doneMon, MON)
expect('a Done tick shows the item as done today and it still counts towards the 8', selMon.items.length === 8 && selMon.items.find((i) => i.id === monday.items[3].id)!.mark === 'done' && selMon.doneCount === 1 && selMon.openCount === 7)
const dayItem = monday.items.find((i) => !i.persist)!
const doneDay = applyMark({}, siteDay(MON), dayItem, 'done')
expect('a daily tick holds on the same day', markOf(doneDay, siteDay(MON), dayItem.id) === 'done')
expect('a daily tick does NOT carry to the next day (the list is fresh each day)', markOf(doneDay, siteDay(TUE), dayItem.id) === 'open')
const permItem = allCandidates(sources(MON)).find((i) => i.persist && i.group === 'setup')!
const donePerm = applyMark({}, siteDay(MON), permItem, 'done')
expect('a setup or lead tick is kept for good and carries to every later day', markOf(donePerm, siteDay(TUE), permItem.id) === 'done' && markOf(donePerm, '2027-01-01', permItem.id) === 'done' && (donePerm[PERSIST_BUCKET] ?? []).includes(permItem.id))
expect('a finished setup step stops appearing: the next one takes its place', (() => {
  const first = setupCandidates({}, siteDay(MON))
  const sameDay = setupCandidates(donePerm, siteDay(MON))
  const after = setupCandidates(donePerm, siteDay(TUE))
  return first.length === SETUP_AT_ONCE && sameDay.some((i) => i.id === permItem.id) && !after.some((i) => i.id === permItem.id) && after.length === SETUP_AT_ONCE
})())
expect('all six setup steps are defined and each has a reason, a time and a link', SETUP_FOLLOWUPS.length === 6 && SETUP_FOLLOWUPS.every((s) => s.why.length > 10 && s.minutes > 0 && s.href.length > 1) && ['bio-link', 'search-console-indexing', 'business-listings', 'social-connected', 'reviews-requested', 'email-workflow'].every((k) => SETUP_FOLLOWUPS.some((s) => s.key === k)))
expect('once every setup step is done none is left', setupCandidates({ [PERSIST_BUCKET]: SETUP_FOLLOWUPS.map((s) => `setup:${s.key}`) }, siteDay(MON)).length === 0)
const laterState = applyMark({}, siteDay(MON), dayItem, 'later')
expect('Later hides the item for today only and it is back tomorrow', markOf(laterState, siteDay(MON), dayItem.id) === 'later' && markOf(laterState, siteDay(TUE), dayItem.id) === 'open' && selectFollowups(allCandidates(sources(MON)), laterState, MON).laterCount === 1)
expect('Undo (reopen) takes either tick back', markOf(applyMark(doneDay, siteDay(MON), dayItem, 'reopen'), siteDay(MON), dayItem.id) === 'open' && markOf(applyMark(donePerm, siteDay(MON), permItem, 'reopen'), siteDay(TUE), permItem.id) === 'open' && markOf(applyMark(laterState, siteDay(MON), dayItem, 'reopen'), siteDay(MON), dayItem.id) === 'open')
expect('a second tick on the same task does not double it', applyMark(applyMark({}, siteDay(MON), dayItem, 'done'), siteDay(MON), dayItem, 'done')[siteDay(MON)].filter((x) => x === dayItem.id).length === 1)

// finished
const everything = allCandidates(sources(MON))
const allTicked = selectFollowups(everything, monday.items.reduce<DoneState>((s, it) => applyMark(s, siteDay(MON), it, 'done'), {}), MON)
expect('"All done for today" shows when every item is ticked', allTicked.allDone && allTicked.openCount === 0 && allTicked.doneCount === 8)
expect('an empty day (nothing to do) is also all done, never an error', selectFollowups([], {}, MON).allDone && selectFollowups([], {}, MON).items.length === 0)
expect('the panel says "All done for today"', /All done for today/.test(read('components/admin/followups-panel.tsx')))

// bounded
const many: DoneState = {}
for (let d = 1; d <= 30; d++) many[`2026-09-${String(d).padStart(2, '0')}`] = ['social:routine']
for (let d = 1; d <= 20; d++) many[`2026-10-${String(d).padStart(2, '0')}`] = Array.from({ length: 200 }, (_, i) => `links:t${i}`)
many[PERSIST_BUCKET] = Array.from({ length: 900 }, (_, i) => `setup:s${i}`)
const bounded = boundDone(many)
expect(`the stored ticks keep only ${DAYS_KEPT} days, and each bucket is capped`, Object.keys(bounded).filter((k) => k !== PERSIST_BUCKET).length === DAYS_KEPT && Object.values(bounded).every((l) => l.length <= Math.max(DAY_BUCKET_MAX, PERSIST_MAX)) && bounded[PERSIST_BUCKET].length === PERSIST_MAX && Object.keys(bounded).filter((k) => k !== PERSIST_BUCKET).every((k) => bounded[k].length <= DAY_BUCKET_MAX))
expect('the newest days are the ones kept', Object.keys(bounded).includes('2026-10-20') && !Object.keys(bounded).includes('2026-09-01'))
expect('writing a tick on a later day drops the oldest days', (() => {
  let s: DoneState = {}
  for (let d = 1; d <= 20; d++) s = applyMark(s, `2026-10-${String(d).padStart(2, '0')}`, { id: 'social:routine', persist: false }, 'done')
  return Object.keys(s).length === DAYS_KEPT && !('2026-10-01' in s) && '2026-10-20' in s
})())
expect('junk in the stored ticks is ignored', Object.keys(parseDone('{"bad":["x"],"2026-10-24":"no","2026-10-25":[1,"social:routine"]}')).join(',') === '2026-10-25' && parseDone('not json') && Object.keys(parseDone('[]')).length === 0 && Object.keys(parseDone(null)).length === 0 && parseDone(serializeDone(doneDay))[siteDay(MON)].includes(dayItem.id))

// stored list and counts
const stored = parseList(serializeList(siteDay(MON), MON, everything))
expect('the stored list round-trips and is fresh for 10 minutes on the same day only', !!stored && stored.items.length === everything.length && listIsFresh(stored, new Date(MON.getTime() + 5 * 60_000)) && !listIsFresh(stored, new Date(MON.getTime() + 11 * 60_000)) && !listIsFresh(stored, TUE) && !listIsFresh(null, MON))
expect('the menu count comes from the stored list and the ticks, and is unknown (null) for a list from another day', openCountFrom(stored, {}, MON)?.open === 8 && openCountFrom(stored, doneDay, MON)?.open === 7 && openCountFrom(stored, {}, TUE) === null && openCountFrom(null, {}, MON) === null)
expect('slug ids are stable and two long lines that start alike stay apart', slug('Write about the 3 searches that grew this week and next') === slug('Write about the 3 searches that grew this week and next') && slug('Write about the 3 searches that grew this week and nextA') !== slug('Write about the 3 searches that grew this week and next'))

// the brief
const sel = selectFollowups(everything, {}, MON)
const bf = briefFollowups(sel, 'https://www.travelfunbiz.ca')
expect('the brief lists only open items, each with a full one-tap link', bf.length === 8 && bf.every((f) => /^https?:\/\//.test(f.url)) && briefFollowups(allTicked, 'https://x.ca').length === 0)
const BRIEF: Brief = {
  dateLabel: 'Monday, October 26', actions: [], stats: [{ value: '3', label: 'Blog posts written' }], yesterday: ['Blog posts: none written.'], today: ['Autopilot is ON.'], working: ['Not enough posts yet to say what works.'], healed: [],
  edits: { lines: [], total: 0, healLines: [] }, tripPages: [], trackerItems: [], followups: bf, check: evaluateCheck(unreadFacts(MON)),
}
const html = briefHtml(BRIEF)
const text = checkBriefLines(BRIEF.check ?? null).join('\n') + bf.map((f) => `${f.title} ${f.why} ${f.url}`).join('\n')
expect('the 7 am brief has a follow-ups section with one-tap buttons and a system check section', /Today&#39;s follow-ups|Today's follow-ups/.test(html) && html.includes('Open it') && html.includes('/admin/follow-ups') && html.includes('System check') && html.includes('/admin/system-check'))
expect('the brief section builds without a long dash', !DASH.test(html) && !DASH.test(text))
expect('a brief without the new data still builds (the sections are left out)', (() => { const h = briefHtml({ ...BRIEF, followups: null, check: undefined }); return !h.includes('follow-ups') && !h.includes('System check') })())
expect('an empty follow-ups list leaves the section out', !briefHtml({ ...BRIEF, followups: [] }).includes("Today's follow-ups"))
const debrief = read('lib/debrief.ts')
expect('the brief builder reads the follow-ups and the stored system check, and renders both in the plain-text version', /readBriefFollowups/.test(debrief) && /getCheckForBrief/.test(debrief) && /TODAY'S FOLLOW-UPS/.test(debrief) && /SYSTEM CHECK/.test(debrief))

// =================================================================================================
// 3. The system check
// =================================================================================================
const NOW = new Date('2026-10-24T15:00:00Z')
const GREEN: CheckFacts = {
  now: NOW,
  watchdog: {
    at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    checks: [
      { stage: 'production', status: 'ok', evidence: { hours_since_last_blog_post: 20, threshold_hours: 72, guides_published_48h: 3 } },
      { stage: 'quality', status: 'ok', evidence: { posts_below_bar: 2, published_posts: 40 } },
      { stage: 'distribution', status: 'ok', evidence: { mode: 'auto', sends_36h: 4, queued_rows: 1 } },
      { stage: 'discovery', status: 'ok', evidence: { new_pages_missing_from_sitemap: 0 } },
      { stage: 'clicks', status: 'ok', evidence: { underperforming_styles: 0, needs_more_data: 'no' } },
      { stage: 'conversion', status: 'ok', evidence: { pages_with_visits_and_no_leads: 0, visit_floor: 100 } },
      { stage: 'measurement', status: 'ok', evidence: { visit_tracking: 'on', visit_rows_48h: 120 } },
    ],
  },
  crawl: { lastRun: NOW.toISOString(), errors: 0, warnings: 0 },
  seo: { score: 80, failing: 1 },
  jobs: { autopilot: { light: 'green', ageHours: 0.1 }, daily: { light: 'green', ageHours: 9 } },
  ai: { spend: 0.4, ceiling: 5 },
  orders: { paid30d: 1, webhookFailing: false },
  gateSkips7d: 0,
  decisions: [],
  migrations: { repoCount: 57, unapplied: [], outOfOrder: [], duplicateNumbers: [], historyEmpty: false },
}
const gr = evaluateCheck(GREEN)
expect('the check has the twelve stages in funnel order', gr.stages.map((s) => s.id).join(',') === STAGE_IDS.join(',') && STAGE_IDS.join(',') === 'production,quality,distribution,discovery,clicks,conversion,measurement,money,seo,jobs,ai,migrations')
expect('a healthy site is green on every stage, overall and has no worst stage', gr.overall === 'green' && gr.worst === null && gr.stages.every((s) => s.light === 'green'))
const stageOf = (r: ReturnType<typeof evaluateCheck>, id: string) => r.stages.find((s) => s.id === id)!
expect('each watchdog verdict maps: ok green, warn amber, bad red', (() => {
  const f = (status: 'ok' | 'warn' | 'bad') => evaluateCheck({ ...GREEN, watchdog: { at: GREEN.watchdog!.at, checks: [{ stage: 'quality', status, evidence: { posts_below_bar: 9, published_posts: 40 } }] } })
  return stageOf(f('ok'), 'quality').light === 'green' && stageOf(f('warn'), 'quality').light === 'amber' && stageOf(f('bad'), 'quality').light === 'red'
})())
expect('crawl errors turn Discovery amber, ten or more red, and a crawl that never ran is amber', (() => {
  const c = (crawl: CheckFacts['crawl']) => stageOf(evaluateCheck({ ...GREEN, crawl }), 'discovery')
  return c({ lastRun: NOW.toISOString(), errors: 3, warnings: 0 }).light === 'amber' && c({ lastRun: NOW.toISOString(), errors: 10, warnings: 0 }).light === 'red' && c({ lastRun: null, errors: 0, warnings: 0 }).light === 'amber' && c(null).light === 'amber' && !c(null).read
})())
expect('the SEO score is green at 70, amber from 40, red below, amber when never run, amber when unreadable', (() => {
  const s = (seo: CheckFacts['seo']) => stageOf(evaluateCheck({ ...GREEN, seo }), 'seo')
  return s({ score: 70, failing: 0 }).light === 'green' && s({ score: 69, failing: 0 }).light === 'amber' && s({ score: 40, failing: 0 }).light === 'amber' && s({ score: 39, failing: 0 }).light === 'red' && s({ score: null, failing: 0 }).light === 'amber' && s(null).light === 'amber'
})())
expect('the 15 minute job and the daily job go red when quiet; never-reported is amber; a daily check older than 36 hours is amber', (() => {
  const j = (jobs: CheckFacts['jobs'], at = GREEN.watchdog!.at) => stageOf(evaluateCheck({ ...GREEN, jobs, watchdog: { at, checks: GREEN.watchdog!.checks } }), 'jobs')
  return j({ autopilot: { light: 'amber', ageHours: 5 }, daily: { light: 'green', ageHours: 1 } }).light === 'red' && j({ autopilot: { light: 'gray', ageHours: null }, daily: { light: 'green', ageHours: 1 } }).light === 'amber' && j(GREEN.jobs, new Date(NOW.getTime() - 40 * 3_600_000).toISOString()).light === 'amber' && j(GREEN.jobs).light === 'green' && j(null).light === 'amber'
})())
expect('AI spend: green under 80 percent, amber from 80, red over the limit, amber when unreadable', (() => {
  const a = (spend: number | null) => stageOf(evaluateCheck({ ...GREEN, ai: { spend, ceiling: 5 } }), 'ai').light
  return a(1) === 'green' && a(4) === 'amber' && a(5) === 'amber' && a(5.01) === 'red' && a(null) === 'amber'
})())
expect('money: a failing payment hook is red; a count that cannot be read is amber', stageOf(evaluateCheck({ ...GREEN, orders: { paid30d: 3, webhookFailing: true } }), 'money').light === 'red' && stageOf(evaluateCheck({ ...GREEN, orders: { paid30d: null, webhookFailing: false } }), 'money').light === 'amber' && stageOf(evaluateCheck({ ...GREEN, orders: null }), 'money').light === 'amber')
expect('UNKNOWN IS NEVER GREEN: with every fact missing no stage is green, and each says it could not be read', (() => {
  const r = evaluateCheck(unreadFacts(NOW))
  return r.overall === 'amber' && r.stages.every((s) => s.light === 'amber' && !s.read && /could not be read/.test(s.sentence))
})())
expect('UNKNOWN IS NEVER GREEN: one missing fact never leaves a green stage', (() => {
  const facts: (keyof CheckFacts)[] = ['watchdog', 'crawl', 'seo', 'jobs', 'ai', 'orders']
  return facts.every((k) => evaluateCheck({ ...GREEN, [k]: null }).stages.every((s) => s.read || s.light !== 'green'))
})())
expect('the worst stage is the first red, else the first amber', (() => {
  const r = evaluateCheck({ ...GREEN, ai: { spend: 9, ceiling: 5 }, seo: { score: 50, failing: 1 } })
  return r.overall === 'red' && r.worst?.id === 'ai' && evaluateCheck({ ...GREEN, seo: { score: 50, failing: 1 } }).worst?.id === 'seo'
})())
expect('worstLight is red over amber over green', worstLight(['green', 'amber']) === 'amber' && worstLight(['green', 'red', 'amber']) === 'red' && worstLight([]) === 'green')

// what the site fixed by itself
const d = (policy: string, subject: string, action: string, hoursAgo: number, extra: Partial<DecisionLike> = {}): DecisionLike => ({ at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), policy, subject, action, ...extra })
const log: DecisionLike[] = [
  d('retry_failed_posts', 'p1', 'Queued the failed post again', 2),
  d('funnel_watchdog', 'production', 'Asked the blog writer to run on the next pass', 3),
  d('funnel_watchdog', 'instagram', 'Paused instagram for 24 hours', 4),
  d('funnel_watchdog', 'conversion', 'Needs Joel: a page has no leads', 4),
  d('approve_safe_topics', 'kw', 'Approved the topic "cruise tips"', 30),
  d('release_held_posts', 'p2', 'Released a held post', 5, { undone_at: NOW.toISOString() }),
  d('seo_links', 'a|b', 'Added a link between two pages', 6),
  d('publish_passing_news', 'n1', 'Refused: the news brief failed a check', 1),
]
const fixed = fixedByStage(log, NOW)
expect('fixes are grouped by stage from the last 24 hours only', (fixed.distribution ?? []).length === 2 && (fixed.production ?? []).length === 1 && (fixed.discovery ?? []).length === 1, JSON.stringify(fixed))
expect('a refusal, a "Needs" line, an undone action and anything older than a day are not fixes', !JSON.stringify(fixed).includes('Needs Joel') && !JSON.stringify(fixed).includes('Refused') && !JSON.stringify(fixed).includes('Released') && !JSON.stringify(fixed).includes('cruise tips'))
expect('a network the watchdog paused counts under Distribution', stageOfDecision(d('funnel_watchdog', 'instagram', 'x', 1)) === 'distribution' && stageOfDecision(d('funnel_watchdog', 'quality', 'x', 1)) === 'quality' && stageOfDecision(d('nope', 'x', 'x', 1)) === null)
const withFixes = evaluateCheck({ ...GREEN, decisions: log })
expect('the fixes show on their stage, and "needs you" is only on stages that are not green', stageOf(withFixes, 'distribution').fixed.length === 2 && stageOf(withFixes, 'production').fixed.length === 1 && withFixes.stages.every((s) => (s.light === 'green') === (s.needs === null)))
expect('an unreadable log shows no fixes and no crash', evaluateCheck({ ...GREEN, decisions: null }).stages.every((s) => s.fixed.length === 0))
expect('"needs you" links to a real admin page', evaluateCheck(unreadFacts(NOW)).stages.every((s) => !!s.needs && s.needs.href.startsWith('/admin') && s.needs.text.length > 3))

// store and cache
const stored2 = parseCheck(serializeCheck(withFixes))
expect('the stored answer round-trips', !!stored2 && stored2.overall === withFixes.overall && stored2.stages.length === 12 && stored2.stages[2].fixed.length === 2 && stored2.at === withFixes.at)
expect('junk or the wrong version is not an answer', parseCheck('x') === null && parseCheck('{"v":2}') === null && parseCheck(null) === null && parseCheck('{"v":1,"at":"2026-10-24T00:00:00Z","stages":[]}') === null)
expect('an answer is reused for 5 minutes and not after, and a clock in the future is not fresh', SYSTEM_CHECK_TTL_MS === 300_000 && isFresh(NOW.toISOString(), NOW.getTime() + 299_000) && !isFresh(NOW.toISOString(), NOW.getTime() + 301_000) && !isFresh(NOW.toISOString(), NOW.getTime() - 3_600_000) && !isFresh('junk', NOW.getTime()))
expect('the summary counts the lights', (() => { const s = summarizeCheck(evaluateCheck({ ...GREEN, ai: { spend: 9, ceiling: 5 } })); return s.counts.red === 1 && s.counts.green === 11 && s.overall === 'red' })())
const runSrc = read('lib/system-check-run.ts')
expect('the reader reads each fact on its own and saves its own answer under system_check_state', (runSrc.match(/await safe\(/g) ?? []).length >= 8 && /SYSTEM_CHECK_KEY/.test(runSrc) && read('lib/system-check.ts').includes("'system_check_state'"))
expect('the reader reuses the watchdog, the issues list, the cron judge, the crawl state, the SEO audit and the AI tripwire', ['funnel-watchdog', 'plain-steps', 'cron-health', 'site-crawl', 'seo-playbook-view', 'ai-tripwire', 'auto-decisions', 'issues'].every((m) => runSrc.includes(`@/lib/${m}`)))
expect('the reader makes no AI call and sends nothing', !/anthropic|openai|fetch\(|sendMail|resend/i.test(runSrc))
const cron = read('app/api/cron/gsc-snapshot/route.ts')
expect('the daily step computes the check and stores it (no new cron)', /getSystemCheck\(getSupabaseAdmin\(\), \{ force: true \}\)/.test(cron) && !/system-check/.test(read('vercel.json')) && JSON.parse(read('vercel.json')).crons.length === 2)

// =================================================================================================
// 4. Routes and pages
// =================================================================================================
const firstLineAuth = (file: string, methods: string[]) => {
  const src = read(file)
  const hs = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(request: Request\) \{\r?\n([^\n]*)\n/g)]
  return hs.length === methods.length && methods.every((m) => hs.some((h) => h[1] === m && /isAuthorized\(request\)/.test(h[2])))
}
expect('GET and POST /api/admin/system-check call isAuthorized first', firstLineAuth('app/api/admin/system-check/route.ts', ['GET', 'POST']))
expect('GET and POST /api/admin/follow-ups call isAuthorized first', firstLineAuth('app/api/admin/follow-ups/route.ts', ['GET', 'POST']))
expect('the Today route still calls isAuthorized first in GET and POST', firstLineAuth('app/api/admin/today/route.ts', ['GET', 'POST']))
const fu = read('app/api/admin/follow-ups/route.ts')
expect('the follow-ups POST validates the id and the op before touching anything', /isFollowId\(body\.id\)/.test(fu) && /body\.op !== 'done' && body\.op !== 'later' && body\.op !== 'reopen'/.test(fu))
expect('a tick is only accepted for a task on the saved list', /That task is not on today/.test(read('lib/followups-run.ts')) && /list\?\.items\.find/.test(read('lib/followups-run.ts')))
expect('the ticks are saved in one value, followups_done, and the list in followups_list', read('lib/followups.ts').includes("'followups_done'") && read('lib/followups.ts').includes("'followups_list'"))
expect('the follow-ups reader reuses the growth digest, the SEO fix list, the Today lead-reply list, link building and the recap list', ['growth-digest-read', 'seo-playbook-todo', 'today-state', 'links-building-data', 'recap-store'].every((m) => read('lib/followups-run.ts').includes(`@/lib/${m}`)))
expect('a lead already answered on Today is excluded, and an unreadable answered list leaves leads out', /TODAY_LEADS_DONE_KEY/.test(read('lib/followups-run.ts')) && /replied === null \? items\.filter\(\(i\) => i\.group !== 'lead'\)/.test(read('lib/followups-run.ts')))
expect('newsletter signups and trip alerts are not leads waiting for a reply', /newsletter signup/.test(read('lib/followups-run.ts')) && /trip alert/.test(read('lib/followups-run.ts')))

// =================================================================================================
// 5. Today
// =================================================================================================
const page = read('app/admin/page.tsx')
const stack = read('components/admin/today-stack.tsx')
expect('/admin is ONLY the swipe cards: no system check strip, no follow-ups section, no dashboard', page.indexOf('<TodayStack') > 0 && stack.includes('data-testid="today-card"') && !/SystemCheckStrip|FollowupsPanel|system-check-strip/.test(stack) && !page.includes('id="dashboard"') && !page.includes('<DashboardRangePills') && !page.includes('<FunnelPanel') && !existsSync(join(process.cwd(), 'components/admin/system-check-strip.tsx')))
expect('the empty Today says "All done for today" with links to Daily follow-ups and the Dashboard', /All done for today/.test(stack) && /href="\/admin\/follow-ups"/.test(stack) && /href="\/admin\/dashboard"/.test(stack) && /data-testid="today-empty"/.test(stack))
expect('the Today cards keep Later and Undo, and the menu keeps the card count badge', /Undo last/.test(stack) && /Later/.test(stack) && adminNavLinks.find((l) => l.title === 'Today')!.badge === 'today')
expect('the follow-ups list is its own page with only the list (no collapsible wrapper any more)', !/aria-expanded=\{open\}/.test(read('components/admin/followups-panel.tsx')) && !/collapsible/.test(read('components/admin/followups-panel.tsx')))
const seo = TODAY_KINDS['seo-fix']
expect("'seo-fix' is a registered Today card kind: Do it opens the fix, Later hides it for 7 days", TODAY_KIND_IDS.includes('seo-fix') && seo.primary.label === 'Do it' && seo.primary.mode === 'open' && seo.secondary === null && seo.snoozeDays === 7 && actionFor('seo-fix', 'approve')?.label === 'Do it' && actionFor('seo-fix', 'reject') === null)
expect('an open button never needs a confirm tap and the card id is checked', !needsConfirm('seo-fix', 'approve') && parseCardId('seo-fix:tech-sitemap')?.kind === 'seo-fix' && parseCardId('seo-fix:../x') === null)
expect('the Today queue builds the SEO cards from lib/seo-playbook-todo.ts', /readSeoFixCandidates/.test(read('lib/today-queue.ts')) && /\['SEO fixes'/.test(read('lib/today-queue.ts')) && /card\('seo-fix'/.test(read('lib/today-queue.ts')))
expect('the Today route also returns the system check summary, the top fixes and the follow-up count', /check: checked\.check,\s*fixes: checked\.fixes,\s*followups,/.test(read('app/api/admin/today/route.ts')) && /readFollowupsCount/.test(read('app/api/admin/today/route.ts')))

// =================================================================================================
// 6. Dashboard is its own page; the system check ends in a "Fix these today" list
// =================================================================================================
expect('Dashboard menu entry is step 4 and goes to /admin/dashboard; Today stays /admin; no #dashboard anchor anywhere in the nav', stepOf('Dashboard') === 4 && adminNavLinks.find((l) => l.title === 'Dashboard')!.href === '/admin/dashboard' && adminNavLinks.find((l) => l.title === 'Today')!.href === '/admin' && !/#dashboard/.test(read('lib/admin-nav.ts')) && adminNavItems[0].href === '/admin/dashboard')
expect('the dashboard page exists, has the range pills, the tiles, the one traffic chart FIRST, top pages, top posts, top keywords and the funnel, and no admin tools grid', (() => {
  const d = read('app/admin/dashboard/page.tsx')
  return existsSync(join(process.cwd(), 'app/admin/dashboard/page.tsx')) && ['<DashboardRangePills', '<StatTile', '<TrafficChartCard', '<TopPagesCard', '<TopPostsCard', '<TopKeywordsCard', '<FunnelPanel', 'RANGE_STORAGE_KEY'].every((s) => d.includes(s)) && !d.includes('adminTools') && !d.includes('Admin Tools') && !d.includes('<TodayStack') && !/<TrafficCard|<SearchCard|<VisitsCard/.test(d) && d.indexOf('<TrafficChartCard') < d.indexOf('<TopPagesCard') && d.indexOf('<TopPagesCard') < d.indexOf('<TopPostsCard') && d.indexOf('<TopPostsCard') < d.indexOf('<TopKeywordsCard') && d.indexOf('<TopKeywordsCard') < d.indexOf('<FunnelPanel')
})())
expect('nothing in the app links to /admin#dashboard any more', ['components/admin/admin-shell.tsx', 'components/admin/today-stack.tsx', 'lib/brief-html.ts', 'lib/today-queue.ts', 'lib/admin-nav.ts'].every((f) => !/admin#dashboard/.test(read(f))))

const FIX_NOW = new Date('2026-10-24T12:00:00Z')
const base = evaluateCheck(unreadFacts(FIX_NOW))
const withLights = (lights: Partial<Record<(typeof STAGE_IDS)[number], 'green' | 'amber' | 'red'>>, read = true) => ({
  ...base,
  stages: base.stages.map((s) => ({ ...s, light: lights[s.id] ?? 'green', read })),
})
const allUnread = buildFixList(base)
expect('every amber or red stage becomes one fix; all-unread gives 12, in impact order (conversion first)', allUnread.length === 12 && allUnread[0].stage === 'conversion' && allUnread[1].stage === 'money' && allUnread[2].stage === 'jobs')
const mixed = buildFixList(withLights({ seo: 'amber', money: 'red', clicks: 'amber', jobs: 'red' }))
expect('red comes before amber, then by impact', mixed.map((f) => f.stage).join(',') === 'money,jobs,clicks,seo', mixed.map((f) => f.stage).join(','))
expect('a red stage that could not be read sorts below a red stage we can see', (() => {
  const r = withLights({ money: 'red', jobs: 'red' })
  r.stages = r.stages.map((s) => (s.id === 'money' ? { ...s, read: false } : s))
  return buildFixList(r).map((f) => f.stage).join(',') === 'jobs,money'
})())
expect('all green gives an empty list (the page says All clear)', buildFixList(withLights({})).length === 0 && buildFixList(null).length === 0)
expect('each fix carries the plain sentence and a page that exists under /admin', mixed.every((f) => f.sentence.length > 5 && f.to.href.startsWith('/admin') && f.to.text.length > 3))
expect('every fix id fits the follow-ups store, and round-trips to its stage', STAGE_IDS.every((id) => isFollowId(fixIdOf(id)) && stageOfFixId(fixIdOf(id)) === id) && stageOfFixId('weekly:fix-nope') === null && stageOfFixId('lead:abc') === null && stageOfFixId(5) === null)
const DAYX = '2026-10-24'
let ticks: DoneState = {}
ticks = applyMark(ticks, DAYX, { id: fixIdOf('money'), persist: false }, 'done')
ticks = applyMark(ticks, DAYX, { id: fixIdOf('jobs'), persist: false }, 'later')
const views = withMarks(mixed, ticks, DAYX)
expect('Done and Later are read from the follow-ups store; only open fixes are in the Today top list', views.find((v) => v.stage === 'money')!.mark === 'done' && views.find((v) => v.stage === 'jobs')!.mark === 'later' && topOpenFixes(views, 3).map((v) => v.stage).join(',') === 'clicks,seo' && summarizeFixes(views).open === 2 && summarizeFixes(views).total === 4)
expect('a tick is for one day: tomorrow the fix is open again', withMarks(mixed, ticks, '2026-10-25').every((v) => v.mark === 'open'))
expect('the top list is capped at 3', topOpenFixes(withMarks(allUnread, {}, DAYX), 3).length === 3 && summarizeFixes(withMarks(allUnread, {}, DAYX)).open === 12)
expect('a reopened fix is open again', withMarks(mixed, applyMark(ticks, DAYX, { id: fixIdOf('money'), persist: false }, 'reopen'), DAYX).find((v) => v.stage === 'money')!.mark === 'open')

const checkRoute = read('app/api/admin/system-check/route.ts')
expect('the system check route has a POST that is admin-checked first, with Run check now (op run) and the ticks', /export async function POST\(request: Request\) \{\s*\n\s*if \(!isAuthorized\(request\)\)/.test(checkRoute) && /op === 'run'/.test(checkRoute) && /tickFix\(/.test(checkRoute) && /answer\(true\)/.test(checkRoute))
expect('a tick is only accepted for a stage that is on the current fix list, and goes into the follow-ups store', /buildFixList\(stored\)\.some/.test(read('lib/system-check-run.ts')) && /FOLLOWUPS_DONE_KEY/.test(read('lib/system-check-run.ts')))
const checkPage = read('app/admin/system-check/page.tsx')
expect('the system check page ends with "Fix these today", says All clear when green, and has Run check now (POST)', /Fix these today/.test(checkPage) && /All clear/.test(checkPage) && /Run check now/.test(checkPage) && /method: "POST"/.test(checkPage) && checkPage.indexOf('<ol className="space-y-3">') < checkPage.indexOf('Fix these today') && /tick\(f\.stage, "done"\)/.test(checkPage) && /tick\(f\.stage, "later"\)/.test(checkPage) && /href=\{f\.to\.href\}/.test(checkPage))
expect('the Fix these today list lives on the system check page only (no longer on Today)', /Fix these today/.test(checkPage) && !/Fix these today/.test(read('components/admin/today-stack.tsx')))
expect('fix sentences are grade-6 plain: short and no long dash (the voice check proves the stage wording)', allUnread.every((f) => f.sentence.split(/\s+/).length <= 40 && !DASH.test(f.sentence + f.to.text + f.label)))

// copy
const NEW_FILES = ['lib/admin-nav.ts', 'lib/system-check.ts', 'lib/system-check-fixes.ts', 'lib/traffic-series.ts', 'app/admin/dashboard/page.tsx', 'components/admin/dashboard-cards.tsx','lib/system-check-run.ts', 'lib/followups.ts', 'lib/followups-run.ts', 'lib/brief-html.ts', 'app/api/admin/system-check/route.ts', 'app/api/admin/follow-ups/route.ts', 'app/admin/system-check/page.tsx', 'app/admin/follow-ups/page.tsx', 'components/admin/followups-panel.tsx', 'components/admin/today-client.ts', 'lib/system-check-prompt.ts', 'lib/system-check-heal.ts', 'lib/followups-actions.ts', 'lib/followups-assist-run.ts', 'lib/dashboard-keywords.ts', 'components/admin/admin-shell.tsx']
const bad = NEW_FILES.filter((f) => DASH.test(read(f).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/─/g, '')))
expect('no long dash in any new or changed file (comments aside)', bad.length === 0, bad.join(','))
expect('no new environment variable was added (nothing to document in .env.example)', !/process\.env\./.test(read('lib/system-check.ts') + read('lib/system-check-run.ts') + read('lib/followups.ts') + read('lib/followups-run.ts')))

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
