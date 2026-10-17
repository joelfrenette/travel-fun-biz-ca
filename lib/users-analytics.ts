// Pure aggregation for the "Users and analytics" admin page. This site has NO end-user accounts and
// none are invented here: the people in the data are the single admin (sign-ins), leads who filled
// the contact form, and visitors. Raw lead messages never leave the server: only counts and the
// most common words are returned.

const DAY = 86_400_000

// ---------- AI cost ----------

export interface ApiCallLite {
  ts: string
  feature: string
  input_tokens: number
  output_tokens: number
  est_cost_usd: number | string
  ok: boolean
}

export interface AiCostRow {
  day: string
  feature: string
  calls: number
  failed: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** Calls grouped by day and feature (newest day first), plus a per-feature total. Pure. */
export function aiCostByFeatureDay(rows: ApiCallLite[]): { byDay: AiCostRow[]; byFeature: { feature: string; calls: number; costUsd: number }[]; totalUsd: number } {
  const map = new Map<string, AiCostRow>()
  for (const r of rows) {
    const day = String(r.ts).slice(0, 10)
    const k = `${day}|${r.feature}`
    const row = map.get(k) ?? { day, feature: r.feature, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    row.calls += 1
    if (!r.ok) row.failed += 1
    row.inputTokens += r.input_tokens || 0
    row.outputTokens += r.output_tokens || 0
    row.costUsd += Number(r.est_cost_usd) || 0
    map.set(k, row)
  }
  const byDay = [...map.values()]
    .map((r) => ({ ...r, costUsd: Math.round(r.costUsd * 1e6) / 1e6 }))
    .sort((a, b) => (a.day === b.day ? b.costUsd - a.costUsd : a.day < b.day ? 1 : -1))
  const feat = new Map<string, { feature: string; calls: number; costUsd: number }>()
  for (const r of byDay) {
    const f = feat.get(r.feature) ?? { feature: r.feature, calls: 0, costUsd: 0 }
    f.calls += r.calls
    f.costUsd += r.costUsd
    feat.set(r.feature, f)
  }
  const byFeature = [...feat.values()].sort((a, b) => b.costUsd - a.costUsd)
  return { byDay, byFeature, totalUsd: Math.round(byDay.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6 }
}

// ---------- admin sign-ins ----------

export interface AuthEventLite {
  ts: string
  kind: 'login_ok' | 'login_fail' | 'logout'
}

/** Last login, sign-ins in the last 7 and 30 days, and counts per week (8) and month (6). Pure. */
export function loginStats(events: AuthEventLite[], now: Date = new Date()) {
  const ok = events.filter((e) => e.kind === 'login_ok')
  const t = (e: AuthEventLite) => Date.parse(e.ts)
  const lastLogin = ok.length ? ok.reduce((a, b) => (b.ts > a.ts ? b : a)).ts : null
  const since = (days: number) => now.getTime() - days * DAY
  const weeks: { weekStart: string; logins: number }[] = []
  for (let i = 7; i >= 0; i--) {
    const start = since((i + 1) * 7)
    const end = since(i * 7)
    weeks.push({ weekStart: new Date(start).toISOString().slice(0, 10), logins: ok.filter((e) => t(e) > start && t(e) <= end).length })
  }
  const months: { month: string; logins: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7)
    months.push({ month: m, logins: ok.filter((e) => e.ts.slice(0, 7) === m).length })
  }
  return {
    lastLogin,
    loginsLast7: ok.filter((e) => t(e) > since(7)).length,
    loginsLast30: ok.filter((e) => t(e) > since(30)).length,
    failedLast30: events.filter((e) => e.kind === 'login_fail' && t(e) > since(30)).length,
    weeks,
    months,
  }
}

// ---------- leads ----------

export interface LeadLite {
  utm_source: string | null
  page_path: string | null
  message: string | null
}

const STOP = new Set(
  ('about above after again also been before being between both cant could does doing done each even from have having here hello into just like looking made make many more most much need only other over please really should some such than that their them then there these they this those through very want were what when where which while will with would your youre thanks thank trip travel hoping interested information').split(' '),
)
const QUESTION_START = /^(what|when|where|who|why|how|can|could|do|does|is|are|will|would|should|which)\b/i

/** Lowercase words of 4+ letters, no digits, no stop words. Pure. */
export function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z']{4,}/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 4 && !STOP.has(w))
}

/** Strip the query string so a tracking token or email in a URL is never shown. Pure. */
export function cleanPath(p: string | null): string {
  const s = (p ?? '').split(/[?#]/)[0].trim()
  return s === '' ? '(unknown)' : s.slice(0, 120)
}

/**
 * Lead volume by source and page, how many leads asked a question, and the most common words.
 * Raw messages are never returned. A word counts only when it appears in at least `minLeads`
 * different leads, so a name or other one-off detail cannot surface. Pure.
 */
export function leadStats(leads: LeadLite[], opts: { topWords?: number; minLeads?: number } = {}) {
  const topN = opts.topWords ?? 20
  const minLeads = opts.minLeads ?? 2
  const bySource = new Map<string, number>()
  const byPage = new Map<string, number>()
  const wordLeads = new Map<string, number>()
  let withMessage = 0
  let questions = 0
  for (const l of leads) {
    const src = (l.utm_source ?? '').trim().toLowerCase() || '(direct or unknown)'
    bySource.set(src, (bySource.get(src) ?? 0) + 1)
    const page = cleanPath(l.page_path)
    byPage.set(page, (byPage.get(page) ?? 0) + 1)
    const msg = (l.message ?? '').trim()
    if (!msg) continue
    withMessage += 1
    if (msg.includes('?') || QUESTION_START.test(msg)) questions += 1
    for (const w of new Set(wordsOf(msg).filter((x) => !/[@\d]/.test(x)))) wordLeads.set(w, (wordLeads.get(w) ?? 0) + 1)
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  return {
    total: leads.length,
    withMessage,
    questions,
    bySource: sorted(bySource).slice(0, 20).map(([source, count]) => ({ source, count })),
    byPage: sorted(byPage).slice(0, 20).map(([page, count]) => ({ page, count })),
    topWords: sorted(wordLeads).filter(([, n]) => n >= minLeads).slice(0, topN).map(([word, leadsWithWord]) => ({ word, leads: leadsWithWord })),
  }
}

// ---------- visitors ----------

export interface VisitLite {
  channel: string
  landing_path: string
  created_at: string
}

/** Visits (one site_visits row per landing), top pages and channels. Needs tracking switched on to have any rows. Pure. */
export function visitorStats(rows: VisitLite[]) {
  if (!rows.length) return { tracked: false as const, message: 'Needs visit tracking switched on', total: 0, byChannel: [], byPage: [], byDay: [] }
  const count = (key: (r: VisitLite) => string) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  }
  return {
    tracked: true as const,
    message: '',
    total: rows.length,
    byChannel: count((r) => r.channel || 'unknown').slice(0, 12).map(([channel, visits]) => ({ channel, visits })),
    byPage: count((r) => cleanPath(r.landing_path)).slice(0, 20).map(([page, visits]) => ({ page, visits })),
    byDay: count((r) => r.created_at.slice(0, 10)).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 30).map(([day, visits]) => ({ day, visits })),
  }
}
