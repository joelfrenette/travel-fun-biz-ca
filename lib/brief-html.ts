import { SITE_URL } from '@/lib/site'
import { CHECKLIST_URL, type PlainAction } from '@/lib/plain-steps'
import type { Brief } from '@/lib/debrief'

// The look of the daily brief email: a red header, yesterday's numbers as tiles, numbered action cards
// with a big button, and colour-coded sections (green = fixed by itself, amber = waiting on you). Built
// from tables and inline styles only, and written to survive Outlook, which ignores margin:auto, padding
// on links and max-width: the page is centred with align="center" on a fixed 640px table, and every
// button, pill and number badge is a table cell with a background colour, not a styled link.
// Plain facts only; every number is passed in already counted (and with test data excluded) by buildBrief.
const RED = '#d81f26'
const INK = '#201c1c'
const SOFT = '#5b5250'
const LINE = '#e7e0dd'
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
const T = 'role="presentation" cellpadding="0" cellspacing="0" border="0"'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const section = (title: string, body: string, accent = RED) =>
  `<tr><td style="padding:26px 28px 0 28px">` +
  `<div style="border-left:5px solid ${accent};padding-left:12px;font-size:13px;letter-spacing:1.6px;font-weight:800;color:${INK};text-transform:uppercase">${esc(title)}</div>` +
  `<div style="padding-top:14px">${body}</div></td></tr>`

const bullets = (items: string[], dot = RED) =>
  `<table ${T} width="100%">` +
  items.map((t) => `<tr><td valign="top" width="18" style="width:18px;color:${dot};font-size:18px;line-height:22px">&bull;</td><td style="font-size:15px;line-height:22px;padding-bottom:7px;color:${INK}">${esc(t)}</td></tr>`).join('') +
  `</table>`

const tile = (value: string, label: string) =>
  `<td width="33%" valign="top" style="padding:5px">` +
  `<table ${T} width="100%"><tr><td align="center" bgcolor="#faf7f5" style="background:#faf7f5;border:1px solid ${LINE};border-radius:10px;padding:14px 6px">` +
  `<div style="font-size:30px;line-height:34px;font-weight:800;color:${RED}">${esc(value)}</div>` +
  `<div style="font-size:12px;color:${SOFT};padding-top:2px">${esc(label)}</div></td></tr></table></td>`

function tiles(stats: Brief['stats']): string {
  if (!stats.length) return ''
  const rows: string[] = []
  for (let i = 0; i < stats.length; i += 3) rows.push(`<tr>${stats.slice(i, i + 3).map((s) => tile(s.value, s.label)).join('')}</tr>`)
  return `<table ${T} width="100%" style="margin-bottom:10px">${rows.join('')}</table>`
}

/** A real button that renders the same everywhere: a coloured table cell wrapping the link. */
const button = (href: string, label: string) =>
  `<table ${T}><tr><td bgcolor="${RED}" style="background:${RED};border-radius:8px;padding:0">` +
  `<a href="${esc(href)}" style="display:block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:800;font-size:15px;font-family:${FONT}">${esc(label)} &rarr;</a>` +
  `</td></tr></table>`

function actionCard(a: PlainAction, n: number): string {
  const steps = a.steps.map((s, i) => `<tr><td valign="top" width="24" style="width:24px;font-size:14px;font-weight:700;color:${RED};padding-bottom:5px">${i + 1}.</td><td style="font-size:14px;line-height:20px;padding-bottom:5px;color:${INK}">${esc(s)}</td></tr>`).join('')
  return (
    `<table ${T} width="100%" style="border:1px solid ${LINE};margin-bottom:14px"><tr>` +
    `<td valign="top" width="54" style="width:54px;padding:16px 0 16px 16px"><table ${T}><tr><td align="center" valign="middle" width="34" height="34" bgcolor="${RED}" style="width:34px;height:34px;background:${RED};border-radius:17px;color:#ffffff;font-weight:800;font-size:16px;font-family:${FONT}">${n}</td></tr></table></td>` +
    `<td style="padding:16px 16px 16px 6px">` +
    `<div style="font-size:16px;font-weight:800;color:${INK}">${esc(a.title)}</div>` +
    `<div style="font-size:14px;line-height:20px;color:${SOFT};padding:4px 0 10px 0">${esc(a.why)}</div>` +
    `<table ${T} width="100%">${steps}</table>` +
    `<div style="padding:10px 0 4px 0">${button(a.url, a.urlLabel)}</div>` +
    (a.paste
      ? `<div style="font-size:12px;color:${SOFT};padding-top:12px">To get this fixed, click the grey box once to select it, copy it (Ctrl+C, or Cmd+C on a Mac), and paste it to Claude. ` +
        `On the page above there is also a <b>Copy for Claude</b> button.</div>` +
        `<table ${T} width="100%" style="margin-top:6px"><tr><td bgcolor="#f6f2f0" style="background:#f6f2f0;border-radius:6px;padding:10px 12px;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:18px;color:${INK};-webkit-user-select:all;user-select:all">${esc(a.paste)}</td></tr></table>`
      : '') +
    `</td></tr></table>`
  )
}

export function briefHtml(b: Brief): string {
  const n = b.actions.length
  const pill = n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'All clear'
  const pillColor = n ? RED : '#1a7d4a'

  const header =
    `<tr><td align="center" bgcolor="${RED}" style="background:${RED};padding:26px 28px 24px 28px">` +
    `<div style="font-size:12px;letter-spacing:2.4px;color:#ffd6d6;font-weight:800">TRAVELFUN.BIZ &nbsp;&middot;&nbsp; DAILY BRIEF</div>` +
    `<div style="font-size:28px;line-height:34px;font-weight:800;color:#ffffff;padding-top:8px">Good morning, Joel</div>` +
    `<div style="font-size:15px;color:#ffe3e3;padding-top:4px">${esc(b.dateLabel)}</div>` +
    `<div style="padding-top:16px"><table ${T} align="center"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:16px;padding:8px 18px;font-weight:800;font-size:13px;color:${pillColor};font-family:${FONT}">${esc(pill)}</td></tr></table></div>` +
    `</td></tr>`

  const needs = n
    ? section(`Do these first (${n})`, b.actions.slice(0, 6).map((a, i) => actionCard(a, i + 1)).join('') + (n > 6 ? `<div style="font-size:14px;color:${SOFT}">${n - 6} more on the <a href="${SITE_URL}/admin/autopilot" style="color:${RED}">Content Autopilot page</a>.</div>` : ''))
    : section('Nothing needs you today', `<table ${T} width="100%"><tr><td bgcolor="#e8f6ee" style="background:#e8f6ee;border-radius:10px;padding:14px 16px;font-size:15px;color:#1a7d4a;font-weight:600">Everything is running by itself. Enjoy your day.</td></tr></table>`, '#1a7d4a')

  const panel = (bg: string, inner: string) => `<table ${T} width="100%"><tr><td bgcolor="${bg}" style="background:${bg};border-radius:10px;padding:12px 16px">${inner}</td></tr></table>`

  const yesterday = section('Yesterday', tiles(b.stats) + bullets(b.yesterday))
  const today = section('Today', bullets(b.today, '#3763c9'), '#3763c9')
  const working = section('What is working', bullets(b.working, '#1a7d4a'), '#1a7d4a')
  const healed = b.healed.length ? section('Fixed by itself', panel('#e8f6ee', bullets(b.healed, '#1a7d4a')), '#1a7d4a') : ''
  // WP10 "Edits made": one bullet per automatic edit in the last 24 hours, the drafts waiting on a person, and the
  // link to review or undo. Left out when there is nothing to say. Same table-and-inline-style pattern as the rest.
  const editsBullets = [
    ...(b.edits.total > 0 ? b.edits.lines : ['No automatic edits in the last 24 hours.']),
    ...(b.edits.total > b.edits.lines.length ? [`and ${b.edits.total - b.edits.lines.length} more`] : []),
    ...(b.edits.hardWaiting ? [`${b.edits.hardWaiting} draft${b.edits.hardWaiting === 1 ? ' is' : 's are'} waiting on you: held back for a price, a date, a claim or a link that a person should judge.`] : []),
  ]
  const edits =
    b.edits.total > 0 || b.edits.hardWaiting
      ? section('Edits made', panel('#eaf0fb', bullets(editsBullets, '#3763c9') + `<div style="font-size:14px;padding-top:2px"><a href="${SITE_URL}/admin/content-edits" style="color:${RED};font-weight:700">Review or undo them &rarr;</a></div>`), '#3763c9')
      : ''
  const tripPages = b.tripPages.length
    ? section('Trip pages that need details', panel('#fbf0dd', bullets(b.tripPages, '#a9660b') + `<div style="font-size:14px;padding-top:2px"><a href="${SITE_URL}/admin/packages" style="color:${RED};font-weight:700">Open Packages &rarr;</a></div>`), '#a9660b')
    : ''
  const waiting = b.trackerItems.length
    ? section('Waiting on you (not urgent)', panel('#fbf0dd', bullets(b.trackerItems.map((t) => `${t.priority}: ${t.title}`), '#a9660b') + `<div style="font-size:14px;padding-top:2px"><a href="${SITE_URL}/admin/tracker" style="color:${RED};font-weight:700">Open the project tracker &rarr;</a></div>`), '#a9660b')
    : ''

  const footer =
    `<tr><td style="padding:30px 28px 0 28px"></td></tr>` +
    `<tr><td align="center" bgcolor="${INK}" style="background:${INK};padding:20px 28px;font-size:13px;line-height:20px;color:#bfb2ae">` +
    `<b style="color:#ffffff">Aiva</b> from TravelFunBiz.ca<br>` +
    `<a href="${SITE_URL}/admin/autopilot" style="color:#ff8a86">Content Autopilot</a> &nbsp;|&nbsp; <a href="${CHECKLIST_URL}" style="color:#ff8a86">Setup checklist</a> &nbsp;|&nbsp; <a href="${SITE_URL}/admin/tracker" style="color:#ff8a86">Tracker</a>` +
    `</td></tr>`

  // Outer full-width table centres the fixed-width card in every email program.
  return (
    `<table ${T} width="100%" bgcolor="#f4efec" style="background:#f4efec;font-family:${FONT}"><tr><td align="center" style="padding:24px 10px">` +
    `<table ${T} width="640" align="center" bgcolor="#ffffff" style="width:640px;max-width:100%;background:#ffffff">` +
    header + needs + yesterday + today + working + healed + edits + tripPages + waiting + footer +
    `</table></td></tr></table>`
  )
}
