import type { SupabaseClient } from '@supabase/supabase-js'
import { SITE_URL, site } from '@/lib/site'
import { collectIssues } from '@/lib/issues'
import { plainAction, CHECKLIST_URL, type PlainAction } from '@/lib/plain-steps'
import { readHealLog } from '@/lib/heal'
import { ghlListPublishedPosts } from '@/lib/ghl-social'
import { getAutoblogPostsPerWeek, isPublishDayDue, currentWeekday } from '@/lib/autoblog-cadence'
import { isAutopilotOn } from '@/lib/autopilot'

// The daily brief: one email at 7 am (site time) from "Aiva from TravelFunBiz.ca" with what happened
// yesterday, what is planned today, and the few things only a person can do, each with the exact link
// and plain steps. Facts only: every number comes from the database or GoHighLevel's own records, and
// anything that cannot be read is said to be unknown rather than guessed. Sent through Resend, at most
// once per day (an atomic claim, so two overlapping passes cannot send it twice).
const TO_DEFAULT = 'joelfrenette@gmail.com'
const SEND_HOUR = 7
const TRACKER_URL = `${SITE_URL}/admin/tracker`

const tz = site.timeZone
const ymdIn = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const hourIn = (d: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d))
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
/** The UTC instant at which a calendar day starts in the site's time zone. */
function zonedStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(guess))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return new Date(guess - (Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - guess))
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const money = (cents: number, cur = 'CAD') => `${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`

interface Brief {
  dateLabel: string
  actions: PlainAction[]
  yesterday: string[]
  today: string[]
  healed: string[]
  trackerItems: { title: string; priority: string }[]
}

async function countOf(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const r = await q
  return r.error ? null : (r.count ?? 0)
}

export async function buildBrief(admin: SupabaseClient, now = new Date()): Promise<Brief> {
  const todayYmd = ymdIn(now)
  const yYmd = addDays(todayYmd, -1)
  const start = zonedStart(yYmd).toISOString()
  const end = zonedStart(todayYmd).toISOString()
  const yesterday: string[] = []

  // Posts written yesterday
  const { data: posts, error: postsErr } = await admin.from('posts').select('title, slug, status').gte('created_at', start).lt('created_at', end).order('created_at')
  if (postsErr) yesterday.push('Blog posts: could not read them.')
  else if (!posts?.length) yesterday.push('Blog posts: none written.')
  else for (const p of posts as { title: string; slug: string; status: string }[]) yesterday.push(`Blog post ${p.status === 'published' ? 'published' : 'saved as a draft'}: ${p.title} - ${SITE_URL}/blog/${p.slug}`)

  // What really went out on social, from GoHighLevel's own records
  try {
    const live = (await ghlListPublishedPosts(3)).filter((p) => p.at >= start && p.at < end)
    const byNet = new Map<string, number>()
    for (const p of live) byNet.set(p.platform, (byNet.get(p.platform) ?? 0) + 1)
    yesterday.push(live.length ? `Posts that went live on social: ${[...byNet].map(([n, c]) => `${n} ${c}`).join(', ')}.` : 'Posts that went live on social: none.')
  } catch {
    yesterday.push('Posts that went live on social: could not check.')
  }

  // Leads, signups, orders
  const leadsTotal = await countOf(admin.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', start).lt('created_at', end))
  const signups = await countOf(admin.from('leads').select('id', { count: 'exact', head: true }).eq('package', 'Newsletter signup').gte('created_at', start).lt('created_at', end))
  if (leadsTotal === null || signups === null) yesterday.push('Leads and signups: could not read them.')
  else yesterday.push(`New leads from the contact form: ${leadsTotal - signups}. Newsletter signups: ${signups}.`)
  const { data: orders } = await admin.from('orders').select('amount_cents, currency, is_test, status').gte('created_at', start).lt('created_at', end)
  const real = ((orders ?? []) as { amount_cents: number | null; currency: string | null; is_test: boolean; status: string }[]).filter((o) => !o.is_test && o.status === 'paid')
  if (real.length) yesterday.push(`Payments recorded: ${real.length}, total ${money(real.reduce((s, o) => s + (o.amount_cents ?? 0), 0), real[0].currency ?? 'CAD')}.`)

  // Google Search numbers (they lag by a day or two, so the date is shown)
  const { data: gsc } = await admin.from('gsc_ranking_days').select('day, clicks, impressions').order('day', { ascending: false }).limit(1)
  const g = (gsc ?? [])[0] as { day: string; clicks: number | null; impressions: number | null } | undefined
  if (g) yesterday.push(`Google Search (latest day available, ${g.day}): ${g.impressions ?? 0} times shown, ${g.clicks ?? 0} clicks.`)

  // Today
  const today: string[] = []
  const on = await isAutopilotOn(admin).catch(() => false)
  today.push(on ? 'Autopilot is ON.' : 'Autopilot is OFF, so nothing will be written or posted.')
  if (on) {
    const perWeek = await getAutoblogPostsPerWeek(admin)
    const due = isPublishDayDue(perWeek, currentWeekday(now))
    const wrote = await countOf(admin.from('posts').select('id', { count: 'exact', head: true }).gte('created_at', zonedStart(todayYmd).toISOString()))
    today.push(due ? (wrote ? 'A blog post is already written for today.' : 'A new blog post will be written and published at 9 am.') : 'No new blog post today (the plan is 3 a week).')
    const waitingVideos = await countOf(admin.from('content_pipeline').select('slug', { count: 'exact', head: true }).eq('video_stage', 'pending'))
    if (waitingVideos) today.push(`${waitingVideos} video${waitingVideos === 1 ? ' is' : 's are'} waiting for a free weekly slot.`)
    today.push('Every 15 minutes the site checks for anything due: carousels, videos, posting.')
  }

  // Fixed by itself
  const healed = (await readHealLog(admin)).filter((h) => h.at >= start).map((h) => h.text)

  // What needs a person
  const issues = (await collectIssues(admin).catch(() => [])).sort((a, b) => Number(a.area === 'setup') - Number(b.area === 'setup'))
  const actions = issues.map(plainAction)

  // Ideas and decisions waiting on Joel
  const trackerItems: { title: string; priority: string }[] = []
  for (const pattern of ['JOEL:%', 'DECISION (Joel%']) {
    const { data } = await admin.from('roadmap_usecases').select('title, priority').eq('status', 'backlog').ilike('title', pattern).order('priority').limit(3)
    trackerItems.push(...((data ?? []) as { title: string; priority: string }[]))
  }
  trackerItems.sort((a, b) => a.priority.localeCompare(b.priority))

  return {
    dateLabel: new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(now),
    actions,
    yesterday,
    today,
    healed,
    trackerItems: trackerItems.slice(0, 4),
  }
}

const li = (items: string[]) => items.map((t) => `<li style="margin:6px 0">${esc(t)}</li>`).join('')

export function renderBrief(b: Brief): { subject: string; html: string; text: string } {
  const n = b.actions.length
  const subject = `Aiva's daily brief, ${b.dateLabel}: ${n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'all clear'}`
  const h2 = (t: string) => `<h2 style="font-size:18px;margin:28px 0 8px;color:#201c1c">${esc(t)}</h2>`
  const card = (a: PlainAction) =>
    `<div style="border:1px solid #e7e0dd;border-left:4px solid #d81f26;border-radius:8px;padding:14px 16px;margin:12px 0">` +
    `<div style="font-size:16px;font-weight:700">${esc(a.title)}</div>` +
    `<div style="margin:6px 0;color:#5b5250">${esc(a.why)}</div>` +
    `<ol style="margin:8px 0 8px 20px;padding:0">${li(a.steps)}</ol>` +
    `<a href="${esc(a.url)}" style="display:inline-block;background:#d81f26;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:700">${esc(a.urlLabel)}</a>` +
    (a.paste ? `<div style="margin-top:10px;font-size:13px;color:#5b5250">Copy this and paste it to Claude:</div><div style="background:#f6f2f0;border-radius:6px;padding:8px 10px;font-family:monospace;font-size:13px;white-space:pre-wrap">${esc(a.paste)}</div>` : '') +
    `</div>`
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.5;color:#201c1c;max-width:640px;margin:0 auto;padding:16px">` +
    `<p style="margin:0 0 4px">Good morning Joel,</p><p style="margin:0">Here is your brief for <b>${esc(b.dateLabel)}</b>.</p>` +
    h2(n ? `Do these first (${n})` : 'Nothing needs you today') +
    (n ? b.actions.slice(0, 6).map(card).join('') + (n > 6 ? `<p>${n - 6} more are on the <a href="${SITE_URL}/admin/autopilot">Content Autopilot page</a>.</p>` : '') : '<p>Everything is running by itself. Enjoy your day.</p>') +
    h2('Yesterday') + `<ul style="margin:0 0 0 20px;padding:0">${li(b.yesterday)}</ul>` +
    h2('Today') + `<ul style="margin:0 0 0 20px;padding:0">${li(b.today)}</ul>` +
    (b.healed.length ? h2('Fixed by itself') + `<ul style="margin:0 0 0 20px;padding:0">${li(b.healed)}</ul>` : '') +
    (b.trackerItems.length ? h2('Waiting on you (not urgent)') + `<ul style="margin:0 0 0 20px;padding:0">${li(b.trackerItems.map((t) => `${t.priority}: ${t.title}`))}</ul><p><a href="${TRACKER_URL}">Open the project tracker</a></p>` : '') +
    `<hr style="border:none;border-top:1px solid #e7e0dd;margin:28px 0 12px"><p style="font-size:13px;color:#5b5250;margin:0">Aiva, TravelFunBiz.ca. <a href="${SITE_URL}/admin/autopilot">Content Autopilot</a> | <a href="${CHECKLIST_URL}">Setup checklist</a> | <a href="${TRACKER_URL}">Tracker</a></p></div>`
  const text = [
    `Good morning Joel, here is your brief for ${b.dateLabel}.`,
    '',
    n ? `DO THESE FIRST (${n})` : 'NOTHING NEEDS YOU TODAY',
    ...b.actions.slice(0, 6).flatMap((a, i) => [`${i + 1}. ${a.title}`, `   ${a.why}`, ...a.steps.map((s, k) => `   ${k + 1}) ${s}`), `   ${a.urlLabel}: ${a.url}`, ...(a.paste ? [`   Paste to Claude: ${a.paste}`] : []), '']),
    'YESTERDAY',
    ...b.yesterday.map((t) => `- ${t}`),
    '',
    'TODAY',
    ...b.today.map((t) => `- ${t}`),
    ...(b.healed.length ? ['', 'FIXED BY ITSELF', ...b.healed.map((t) => `- ${t}`)] : []),
    ...(b.trackerItems.length ? ['', 'WAITING ON YOU (not urgent)', ...b.trackerItems.map((t) => `- ${t.priority}: ${t.title}`), `Tracker: ${TRACKER_URL}`] : []),
    '',
    `Content Autopilot: ${SITE_URL}/admin/autopilot`,
  ].join('\n')
  return { subject, html, text }
}

const fromAddress = () => {
  const raw = process.env.ALERT_FROM_EMAIL?.trim() || 'onboarding@resend.dev'
  return /<([^>]+)>/.exec(raw)?.[1] ?? raw
}

export async function sendBrief(brief: Brief): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' }
  const { subject, html, text } = renderBrief(brief)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Aiva from TravelFunBiz.ca <${fromAddress()}>`, to: [process.env.DEBRIEF_TO_EMAIL?.trim() || TO_DEFAULT], subject, html, text }),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return { ok: true }
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    return { ok: false, error: `Resend said ${res.status}${body.message ? `: ${body.message}` : ''}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Resend' }
  }
}

/** Called every pipeline pass. Sends the brief once a day from 7 am site time; returns a short note, or
 * null when there was nothing to do. `force` (a person pressing a button) sends now and does not use up
 * the day's send. */
export async function runDebriefIfDue(admin: SupabaseClient, opts: { force?: boolean } = {}): Promise<{ note: string; ok: boolean } | null> {
  const now = new Date()
  if (!opts.force && hourIn(now) < SEND_HOUR) return null
  const key = `debrief_sent:${ymdIn(now)}`
  if (!opts.force) {
    // Atomic claim: only one pass can insert today's key, so the brief can never be sent twice.
    const { error } = await admin.from('app_settings').insert({ key, value: now.toISOString() })
    if (error) return (error as { code?: string }).code === '23505' ? null : { ok: false, note: `could not claim today's brief: ${error.message}` }
  }
  const sent = await sendBrief(await buildBrief(admin, now))
  if (sent.ok) return { ok: true, note: 'the daily brief was emailed' }
  // Give today's claim back so the next pass tries again (a stuck failure shows up in Needs attention).
  if (!opts.force) await admin.from('app_settings').delete().eq('key', key)
  return { ok: false, note: `the daily brief could not be sent: ${sent.error}` }
}
