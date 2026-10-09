import { SITE_URL } from '@/lib/site'
import { CHECKLIST_URL, type PlainAction } from '@/lib/plain-steps'
import type { Brief } from '@/lib/debrief'

// The look of the daily brief email: a red header, yesterday's numbers as tiles, numbered action cards
// with a big button, and colour-coded sections (green = fixed by itself, amber = waiting on you). Built
// from tables and inline styles only, because email programs ignore most other CSS. Plain facts only;
// every number is passed in already counted (and with test data excluded) by buildBrief.
const RED = '#d81f26'
const INK = '#201c1c'
const SOFT = '#5b5250'
const LINE = '#e7e0dd'
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const section = (title: string, body: string, accent = RED) =>
  `<tr><td style="padding:26px 28px 0 28px">` +
  `<div style="border-left:5px solid ${accent};padding-left:12px;font-size:13px;letter-spacing:1.6px;font-weight:800;color:${INK};text-transform:uppercase">${esc(title)}</div>` +
  `<div style="padding-top:14px">${body}</div></td></tr>`

const bullets = (items: string[], dot = RED) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
  items.map((t) => `<tr><td valign="top" style="width:18px;color:${dot};font-size:18px;line-height:22px">&bull;</td><td style="font-size:15px;line-height:22px;padding-bottom:7px;color:${INK}">${esc(t)}</td></tr>`).join('') +
  `</table>`

const tile = (value: string, label: string) =>
  `<td width="33%" valign="top" style="padding:5px">` +
  `<div style="background:#faf7f5;border:1px solid ${LINE};border-radius:10px;padding:14px 6px;text-align:center">` +
  `<div style="font-size:30px;line-height:34px;font-weight:800;color:${RED}">${esc(value)}</div>` +
  `<div style="font-size:12px;color:${SOFT};padding-top:2px">${esc(label)}</div></div></td>`

function tiles(stats: Brief['stats']): string {
  if (!stats.length) return ''
  const rows: string[] = []
  for (let i = 0; i < stats.length; i += 3) rows.push(`<tr>${stats.slice(i, i + 3).map((s) => tile(s.value, s.label)).join('')}</tr>`)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -5px 10px -5px">${rows.join('')}</table>`
}

function actionCard(a: PlainAction, n: number): string {
  const steps = a.steps.map((s, i) => `<tr><td valign="top" style="width:24px;font-size:14px;font-weight:700;color:${RED};padding-bottom:5px">${i + 1}.</td><td style="font-size:14px;line-height:20px;padding-bottom:5px;color:${INK}">${esc(s)}</td></tr>`).join('')
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:10px;margin-bottom:14px"><tr>` +
    `<td valign="top" style="width:54px;padding:16px 0 16px 16px"><div style="width:34px;height:34px;line-height:34px;border-radius:50%;background:${RED};color:#fff;text-align:center;font-weight:800;font-size:16px">${n}</div></td>` +
    `<td style="padding:16px 16px 16px 6px">` +
    `<div style="font-size:16px;font-weight:800;color:${INK}">${esc(a.title)}</div>` +
    `<div style="font-size:14px;line-height:20px;color:${SOFT};padding:4px 0 10px 0">${esc(a.why)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>` +
    `<div style="padding:8px 0 4px 0"><a href="${esc(a.url)}" style="display:inline-block;background:${RED};color:#ffffff;text-decoration:none;font-weight:800;font-size:15px;padding:12px 20px;border-radius:8px">${esc(a.urlLabel)} &rarr;</a></div>` +
    (a.paste ? `<div style="font-size:12px;color:${SOFT};padding-top:10px">Copy this and paste it to Claude:</div><div style="background:#f6f2f0;border-radius:6px;padding:9px 11px;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:18px;color:${INK}">${esc(a.paste)}</div>` : '') +
    `</td></tr></table>`
  )
}

export function briefHtml(b: Brief): string {
  const n = b.actions.length
  const pill = n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'All clear'
  const pillColor = n ? RED : '#1a7d4a'

  const header =
    `<tr><td style="background:${RED};padding:26px 28px 24px 28px">` +
    `<div style="font-size:12px;letter-spacing:2.4px;color:#ffd6d6;font-weight:800">TRAVELFUN.BIZ &nbsp;&middot;&nbsp; DAILY BRIEF</div>` +
    `<div style="font-size:28px;line-height:34px;font-weight:800;color:#ffffff;padding-top:8px">Good morning, Joel</div>` +
    `<div style="font-size:15px;color:#ffe3e3;padding-top:4px">${esc(b.dateLabel)}</div>` +
    `<div style="padding-top:16px"><span style="display:inline-block;background:#ffffff;color:${pillColor};font-weight:800;border-radius:99px;padding:7px 16px;font-size:13px">${esc(pill)}</span></div>` +
    `</td></tr>`

  const needs = n
    ? section(`Do these first (${n})`, b.actions.slice(0, 6).map((a, i) => actionCard(a, i + 1)).join('') + (n > 6 ? `<div style="font-size:14px;color:${SOFT}">${n - 6} more on the <a href="${SITE_URL}/admin/autopilot" style="color:${RED}">Content Autopilot page</a>.</div>` : ''))
    : section('Nothing needs you today', `<div style="background:#e8f6ee;border-radius:10px;padding:14px 16px;font-size:15px;color:#1a7d4a;font-weight:600">Everything is running by itself. Enjoy your day.</div>`, '#1a7d4a')

  const yesterday = section('Yesterday', tiles(b.stats) + bullets(b.yesterday))
  const today = section('Today', bullets(b.today, '#3763c9'), '#3763c9')
  const healed = b.healed.length ? section('Fixed by itself', `<div style="background:#e8f6ee;border-radius:10px;padding:12px 16px">${bullets(b.healed, '#1a7d4a')}</div>`, '#1a7d4a') : ''
  const waiting = b.trackerItems.length
    ? section('Waiting on you (not urgent)', `<div style="background:#fbf0dd;border-radius:10px;padding:12px 16px">${bullets(b.trackerItems.map((t) => `${t.priority}: ${t.title}`), '#a9660b')}<div style="font-size:14px;padding-top:2px"><a href="${SITE_URL}/admin/tracker" style="color:${RED};font-weight:700">Open the project tracker &rarr;</a></div></div>`, '#a9660b')
    : ''

  const footer =
    `<tr><td style="padding:30px 28px 0 28px"></td></tr>` +
    `<tr><td style="background:${INK};padding:20px 28px;font-size:13px;line-height:20px;color:#bfb2ae">` +
    `<b style="color:#ffffff">Aiva</b> from TravelFunBiz.ca<br>` +
    `<a href="${SITE_URL}/admin/autopilot" style="color:#ff8a86">Content Autopilot</a> &nbsp;|&nbsp; <a href="${CHECKLIST_URL}" style="color:#ff8a86">Setup checklist</a> &nbsp;|&nbsp; <a href="${SITE_URL}/admin/tracker" style="color:#ff8a86">Tracker</a>` +
    `</td></tr>`

  return (
    `<div style="background:#f4efec;padding:24px 10px;font-family:${FONT}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden">` +
    header + needs + yesterday + today + healed + waiting + footer +
    `</table></div>`
  )
}
