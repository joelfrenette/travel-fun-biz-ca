// The Today card registry. Safe to import from the browser: no server code, no database.
//
// Every human decision this admin asks for is ONE card kind here. A kind says: which group it sits in (what is
// urgent, what is an approval, what is only a prompt), what the card says, which facts it shows, what the two big
// buttons do, whether each button can be undone, how long "Later" hides it, and which EXISTING admin route performs
// it (nothing new is invented: lib/today-actions.ts calls the same functions and routes the old screens use).
//
// Phase 2 (automatic decisions) plugs in here: a kind can later gain an `auto` rule without the card model changing.

export type TodayGroup = 'urgent' | 'approve' | 'prompt'

/** What a button does. run = the real action; open = go and look at the page (the card then rests for a day);
 * keep = "leave it as it is", which hides the card for a while without changing anything. */
export type TodayMode = 'run' | 'open' | 'keep'

export interface TodayAction {
  /** Plain words on the big button. */
  label: string
  /** One short line saying what pressing it does (shown small, and read out to screen readers). */
  hint: string
  mode: TodayMode
}

export const TODAY_KIND_IDS = [
  'failed-post',
  'failed-render',
  'video-paused',
  'lead-reply',
  'agent-submission',
  'news-draft',
  'held-guide-post',
  'guide-caption-held',
  'held-post',
  'topic',
  'guide-review',
  'blog-draft',
  'supplier-change',
  'issue-dismiss',
  'promote-prompt',
  'recap-prompt',
  'thin-page',
  'affiliate-setup',
  'seo-fix',
] as const
export type TodayKindId = (typeof TODAY_KIND_IDS)[number]

export interface TodayKindDef {
  kind: TodayKindId
  group: TodayGroup
  /** Position in the whole queue: lower comes first. */
  order: number
  /** The small label on top of the card. */
  badge: string
  /** The default one-line "why you are seeing this". A card may replace it with something more exact. */
  why: string
  /** The names of the facts a card of this kind shows. */
  facts: string[]
  primary: TodayAction
  /** Null when the kind has only one real answer (the left swipe then means "Later"). */
  secondary: TodayAction | null
  /** Can the button be undone? A button that cannot be undone asks for a confirm tap first. */
  undo: { primary: boolean; secondary: boolean }
  /** How many days the "Later" button hides a card of this kind. */
  snoozeDays: number
  /** For a button in mode keep: how many days the card stays hidden. */
  keepDays?: number
  /** For a button in mode open: how many days the card rests after you opened it. */
  openDays?: number
  /** What the part of the card id after "kind:" must look like. Checked on the server before anything is done. */
  idPattern: RegExp
  /** The existing routes or functions that do the work (documentation, and what the offline check verifies). */
  routes: { primary: string; secondary: string | null; undo: string | null }
  /** Repo-relative route files the kind relies on. Each must exist and call isAuthorized first. */
  routeFiles: string[]
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The dismiss buttons Needs attention already offers. Only these may ever be run from a Today card. */
export const DISMISS_ACTIONS = ['dismiss-ghl', 'dismiss-guides', 'dismiss-page-copy', 'dismiss-page-copy-stale', 'dismiss-promotion', 'dismiss-site-crawl'] as const
export type DismissAction = (typeof DISMISS_ACTIONS)[number]

export const TODAY_KINDS: Record<TodayKindId, TodayKindDef> = {
  'failed-post': {
    kind: 'failed-post', group: 'urgent', order: 1, badge: 'Post failed',
    why: 'This post did not go out to social media.',
    facts: ['What went wrong', 'What to try'],
    primary: { label: 'Try again', hint: 'Sends it again, only to the networks that have not got it yet.', mode: 'run' },
    secondary: { label: 'Hold it', hint: 'Stops retrying and parks it on the Post Distribution page.', mode: 'run' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/autopilot {action:issue, kind:retry-post}', secondary: 'POST /api/admin/distribution {action:hold}', undo: 'put the failed state back' },
    routeFiles: ['app/api/admin/autopilot/route.ts', 'app/api/admin/distribution/route.ts'],
  },
  'failed-render': {
    kind: 'failed-render', group: 'urgent', order: 2, badge: 'Video or carousel failed',
    why: 'A carousel or video for a post could not be made.',
    facts: ['What went wrong', 'What to try'],
    primary: { label: 'Try again', hint: 'Queues the carousel or video to be made again.', mode: 'run' },
    secondary: { label: 'Skip it', hint: 'Gives up on this carousel or video; the post stays as it is.', mode: 'run' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, idPattern: /^(video|carousel):[a-z0-9][a-z0-9-]{0,199}$/,
    routes: { primary: 'POST /api/admin/autopilot {action:issue, kind:retry-video|retry-carousel}', secondary: 'POST /api/admin/autopilot {action:issue, kind:dismiss-video|dismiss-carousel}', undo: 'put the failed state back' },
    routeFiles: ['app/api/admin/autopilot/route.ts'],
  },
  'video-paused': {
    kind: 'video-paused', group: 'urgent', order: 3, badge: 'Videos paused',
    why: 'The video service refused our key, so no video is being made.',
    facts: ['What went wrong', 'What to try'],
    primary: { label: 'Resume videos', hint: 'Lets the video step try again now.', mode: 'run' },
    secondary: null,
    undo: { primary: true, secondary: false }, snoozeDays: 1, idPattern: /^paused$/,
    routes: { primary: 'POST /api/admin/autopilot {action:issue, kind:resume-video}', secondary: null, undo: 'put the pause marker back' },
    routeFiles: ['app/api/admin/autopilot/route.ts'],
  },
  'lead-reply': {
    kind: 'lead-reply', group: 'urgent', order: 4, badge: 'New lead',
    why: 'Someone asked about a trip. A quick reply is what turns it into a booking.',
    facts: ['Email', 'Phone', 'Interested in', 'Came in', 'Sent to GoHighLevel'],
    primary: { label: 'I replied', hint: 'Marks this lead as answered so it leaves the list.', mode: 'run' },
    secondary: { label: 'Not a real lead', hint: 'Marks it as spam or a test so it leaves the list.', mode: 'run' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, idPattern: UUID,
    routes: { primary: 'POST /api/admin/today (saved in app_settings today_leads_done)', secondary: 'POST /api/admin/today (saved in app_settings today_leads_done)', undo: 'take the lead back out of today_leads_done' },
    routeFiles: ['app/api/admin/leads/route.ts'],
  },
  'agent-submission': {
    kind: 'agent-submission', group: 'approve', order: 5, badge: 'Agent trip',
    why: 'A travel agent sent you a trip. Nothing is live until you approve it.',
    facts: ['Sent by', 'Their message'],
    primary: { label: 'Approve and publish', hint: 'Publishes the trip on the site.', mode: 'run' },
    secondary: { label: 'Send back', hint: 'Returns it to the agent with a short note. It stays a draft.', mode: 'run' },
    undo: { primary: false, secondary: false }, snoozeDays: 2, idPattern: UUID,
    routes: { primary: 'POST /api/admin/packages/[id]/submission {action:approve}', secondary: 'POST /api/admin/packages/[id]/submission {action:reject}', undo: null },
    routeFiles: ['app/api/admin/packages/[id]/submission/route.ts'],
  },
  'news-draft': {
    kind: 'news-draft', group: 'approve', order: 6, badge: 'Travel news',
    why: 'A news brief is written and waiting for your yes.',
    facts: ['Source', 'Written'],
    primary: { label: 'Approve and publish', hint: 'Takes the brief live, then posts it to social if that is switched on.', mode: 'run' },
    secondary: { label: 'Reject', hint: 'The writer never picks this news item again. The draft stays a draft.', mode: 'run' },
    undo: { primary: false, secondary: true }, snoozeDays: 1, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/news/feeds {action:approve}', secondary: 'POST /api/admin/news/feeds {action:reject}', undo: 'put the news item back to queued' },
    routeFiles: ['app/api/admin/news/feeds/route.ts'],
  },
  'held-guide-post': {
    kind: 'held-guide-post', group: 'approve', order: 7, badge: 'Guide post held',
    why: 'A social post about a guide page is held so a person can look at it first.',
    facts: ['Held since', 'Note'],
    primary: { label: 'Approve', hint: 'Lets it go out on the next posting pass.', mode: 'run' },
    secondary: { label: 'Keep it held', hint: 'Leaves it held and hides this card for a month.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, keepDays: 30, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/distribution {action:approve}', secondary: 'no change (hidden for a while)', undo: 'POST /api/admin/distribution {action:hold}' },
    routeFiles: ['app/api/admin/distribution/route.ts'],
  },
  'guide-caption-held': {
    kind: 'guide-caption-held', group: 'approve', order: 8, badge: 'Caption check failed',
    why: 'A guide post was held because its caption did not pass the checks.',
    facts: ['Held since', 'What the check said'],
    primary: { label: 'Post it as it is', hint: 'Approves the post even though the caption check complained.', mode: 'run' },
    secondary: { label: 'Keep it held', hint: 'Leaves it held and hides this card for a month. Fixing the guide text also releases it.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, keepDays: 30, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/distribution {action:approve}', secondary: 'no change (hidden for a while)', undo: 'POST /api/admin/distribution {action:hold}' },
    routeFiles: ['app/api/admin/distribution/route.ts'],
  },
  'held-post': {
    kind: 'held-post', group: 'approve', order: 9, badge: 'Social post held',
    why: 'Posting is set to Prepare, so this post waits for your yes before it goes to social media.',
    facts: ['Held since', 'Note'],
    primary: { label: 'Approve', hint: 'Lets it go out on the next posting pass.', mode: 'run' },
    secondary: { label: 'Keep it held', hint: 'Leaves it held and hides this card for a month.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 1, keepDays: 30, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/distribution {action:approve}', secondary: 'no change (hidden for a while)', undo: 'POST /api/admin/distribution {action:hold}' },
    routeFiles: ['app/api/admin/distribution/route.ts'],
  },
  topic: {
    kind: 'topic', group: 'approve', order: 10, badge: 'Blog topic',
    why: 'The system suggested a blog topic. Approved topics are what the next auto-written post is about.',
    facts: ['Search phrase', 'Why this one', 'Where the idea came from'],
    primary: { label: 'Approve topic', hint: 'The next blog run can write about it.', mode: 'run' },
    secondary: { label: 'Reject topic', hint: 'It is never suggested again.', mode: 'run' },
    undo: { primary: true, secondary: true }, snoozeDays: 2, idPattern: UUID,
    routes: { primary: 'PATCH /api/admin/blog/topics/[id] {status:approved}', secondary: 'PATCH /api/admin/blog/topics/[id] {status:rejected}', undo: 'PATCH /api/admin/blog/topics/[id] {status:suggested}' },
    routeFiles: ['app/api/admin/blog/topics/[id]/route.ts'],
  },
  'guide-review': {
    kind: 'guide-review', group: 'approve', order: 11, badge: 'Guide page',
    why: 'The AI wrote a guide page and it is waiting in the review queue.',
    facts: ['Kind of page', 'Quality notes', 'Written'],
    primary: { label: 'Publish', hint: 'Puts the guide page live.', mode: 'run' },
    secondary: { label: 'Reject', hint: 'Marks the draft as rejected. It stays a draft.', mode: 'run' },
    undo: { primary: true, secondary: true }, snoozeDays: 2, idPattern: UUID,
    routes: { primary: 'PATCH /api/admin/guides/[id] {status:published}', secondary: 'PATCH /api/admin/guides/[id] {review_state:rejected}', undo: 'PATCH /api/admin/guides/[id] {status:draft} or {review_state:null}' },
    routeFiles: ['app/api/admin/guides/[id]/route.ts'],
  },
  'blog-draft': {
    kind: 'blog-draft', group: 'approve', order: 12, badge: 'Blog draft',
    why: 'A blog post is written and is still a draft.',
    facts: ['Search phrase', 'Written', 'Quality check'],
    primary: { label: 'Publish', hint: 'Puts the post live and tells search engines.', mode: 'run' },
    secondary: { label: 'Keep as draft', hint: 'Leaves it as a draft and hides this card for a month.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 2, keepDays: 30, idPattern: UUID,
    routes: { primary: 'PATCH /api/admin/blog/[id] {status:published}', secondary: 'no change (hidden for a while)', undo: 'PATCH /api/admin/blog/[id] {status:draft}' },
    routeFiles: ['app/api/admin/blog/[id]/route.ts'],
  },
  'supplier-change': {
    kind: 'supplier-change', group: 'prompt', order: 13, badge: 'Supplier page changed',
    why: 'The weekly supplier check thinks this trip is cancelled or its dates changed. Nothing on your site was changed.',
    facts: ['What the check saw'],
    primary: { label: 'It is fine', hint: 'Dismisses the warning for this trip.', mode: 'run' },
    secondary: { label: 'I will check it', hint: 'Hides this card for 3 days so you can look at the trip.', mode: 'keep' },
    undo: { primary: false, secondary: true }, snoozeDays: 1, keepDays: 3, idPattern: SLUG,
    routes: { primary: 'POST /api/admin/autopilot {action:issue, kind:dismiss-source-watch}', secondary: 'no change (hidden for a while)', undo: null },
    routeFiles: ['app/api/admin/autopilot/route.ts'],
  },
  'issue-dismiss': {
    kind: 'issue-dismiss', group: 'prompt', order: 14, badge: 'Needs a look',
    why: 'Something on the Needs attention list can be cleared once you have read it.',
    facts: ['What happened', 'What to do'],
    primary: { label: 'Clear it', hint: 'Dismisses the warning so the system can try again.', mode: 'run' },
    secondary: { label: 'Ask me later', hint: 'Leaves the warning and hides this card for 3 days.', mode: 'keep' },
    undo: { primary: false, secondary: true }, snoozeDays: 1, keepDays: 3, idPattern: /^(dismiss-[a-z-]+)(:[A-Za-z0-9_.:-]{1,200})?$/,
    routes: { primary: 'POST /api/admin/autopilot {action:issue, kind:dismiss-*}', secondary: 'no change (hidden for a while)', undo: null },
    routeFiles: ['app/api/admin/autopilot/route.ts'],
  },
  'promote-prompt': {
    kind: 'promote-prompt', group: 'prompt', order: 15, badge: 'Promote a trip',
    why: 'This live trip has not been promoted in the last 30 days.',
    facts: ['Trip', 'Travels', 'Last promoted'],
    primary: { label: 'Promote it', hint: 'Builds the plan (search phrases, blog ideas, guides and one social post). Uses a little AI credit.', mode: 'run' },
    secondary: { label: 'Not now', hint: 'Hides this card for a month.', mode: 'keep' },
    undo: { primary: false, secondary: true }, snoozeDays: 7, keepDays: 30, idPattern: UUID,
    routes: { primary: 'POST /api/admin/packages/[id]/promote {action:start}', secondary: 'no change (hidden for a while)', undo: null },
    routeFiles: ['app/api/admin/packages/[id]/promote/route.ts'],
  },
  'recap-prompt': {
    kind: 'recap-prompt', group: 'prompt', order: 16, badge: 'Write a recap',
    why: 'This trip has happened and has no recap page yet.',
    facts: ['Trip', 'Ended'],
    primary: { label: 'Open the trip', hint: 'Goes to the trip, where you add photos and notes and press Write the recap.', mode: 'open' },
    secondary: { label: 'Not now', hint: 'Hides this card for a week.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 3, keepDays: 7, openDays: 1, idPattern: SLUG,
    routes: { primary: 'open /admin/packages?edit=[id] (Convert to Past Trip card)', secondary: 'no change (hidden for a while)', undo: 'show the card again' },
    routeFiles: ['app/api/admin/packages/[id]/recap/route.ts'],
  },
  'thin-page': {
    kind: 'thin-page', group: 'prompt', order: 17, badge: 'Thin trip page',
    why: 'A live trip page has too little on it to rank or convert.',
    facts: ['Score', 'What is missing'],
    primary: { label: 'Add details', hint: 'Opens the trip so you can drop in a link, PDF or screenshot.', mode: 'open' },
    secondary: { label: 'Not now', hint: 'Hides this card for a week.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 3, keepDays: 7, openDays: 1, idPattern: SLUG,
    routes: { primary: 'open /admin/packages?edit=[id] (Add details box)', secondary: 'no change (hidden for a while)', undo: 'show the card again' },
    routeFiles: ['app/api/admin/packages/[id]/sources/route.ts'],
  },
  'affiliate-setup': {
    kind: 'affiliate-setup', group: 'prompt', order: 18, badge: 'Affiliate partner',
    why: 'Guide pages are live but no affiliate partner is switched on, so the Fun things to do box is hidden.',
    facts: ['What is missing'],
    primary: { label: 'Open Affiliate Links', hint: 'Goes to the page where you add a partner and set it Active.', mode: 'open' },
    secondary: { label: 'Not now', hint: 'Hides this card for a week.', mode: 'keep' },
    undo: { primary: true, secondary: true }, snoozeDays: 3, keepDays: 7, openDays: 1, idPattern: /^partner$/,
    routes: { primary: 'open /admin/affiliate-links', secondary: 'no change (hidden for a while)', undo: 'show the card again' },
    routeFiles: ['app/api/admin/affiliate-partners/route.ts'],
  },
  'seo-fix': {
    kind: 'seo-fix', group: 'prompt', order: 19, badge: 'SEO fix',
    why: 'This is one of the biggest SEO fixes still open on the SEO and GEO Manager.',
    facts: ['What to do', 'Why it matters'],
    primary: { label: 'Do it', hint: 'Opens the page where the fix is made. The card rests for a day.', mode: 'open' },
    secondary: null,
    undo: { primary: true, secondary: false }, snoozeDays: 7, openDays: 1, idPattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/,
    routes: { primary: 'open the fix page (the page or the item on /admin/seo-manager)', secondary: null, undo: 'show the card again' },
    routeFiles: ['app/api/admin/seo-playbook/route.ts'],
  },
}

export const GROUP_RANK: Record<TodayGroup, number> = { urgent: 0, approve: 1, prompt: 2 }
export const GROUP_LABEL: Record<TodayGroup, string> = { urgent: 'Urgent', approve: 'Needs your yes', prompt: 'When you have a minute' }

export interface TodayFact {
  label: string
  value: string
}

/** One card in the queue. The id is `${kind}:${key}`; everything the server needs to act is inside the id (so a
 * browser can never smuggle extra data in), and it is checked against the kind's idPattern before anything runs. */
export interface TodayCard {
  id: string
  kind: TodayKindId
  title: string
  why: string
  facts: TodayFact[]
  /** A page to read first (a site path or a full web address). */
  link?: { label: string; href: string }
  /** Sorts cards of the same kind: lower first. Usually how old the thing is. */
  sortKey: number
}

export const isKindId = (v: unknown): v is TodayKindId => typeof v === 'string' && (TODAY_KIND_IDS as readonly string[]).includes(v)

export function cardId(kind: TodayKindId, key: string): string {
  return `${kind}:${key}`
}

/** Splits a card id and checks the part after the kind against that kind's pattern. Null when it is not a real id. */
export function parseCardId(id: unknown): { kind: TodayKindId; key: string } | null {
  if (typeof id !== 'string' || id.length > 260) return null
  const at = id.indexOf(':')
  if (at < 1) return null
  const kind = id.slice(0, at)
  if (!isKindId(kind)) return null
  const key = id.slice(at + 1)
  return TODAY_KINDS[kind].idPattern.test(key) ? { kind, key } : null
}

/** The action a swipe or button maps to: right = primary, left = secondary (or Later when there is none). */
export function actionFor(kind: TodayKindId, op: 'approve' | 'reject'): TodayAction | null {
  const def = TODAY_KINDS[kind]
  return op === 'approve' ? def.primary : def.secondary
}

/** True when pressing this button changes something for real and cannot be taken back: it needs a confirm tap. */
export function needsConfirm(kind: TodayKindId, op: 'approve' | 'reject'): boolean {
  const def = TODAY_KINDS[kind]
  const action = actionFor(kind, op)
  if (!action || action.mode !== 'run') return false
  return !(op === 'approve' ? def.undo.primary : def.undo.secondary)
}
