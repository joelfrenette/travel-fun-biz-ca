import type { SupabaseClient } from '@supabase/supabase-js'
import { getGa4Report, getGa4RangeReport, isGa4Configured } from '@/lib/ga4'
import { isVisitTrackingOn } from '@/lib/visit-tracking'
import { funnelByPageType, type PageTypeFunnelRow } from '@/lib/conversion'

// Dashboard funnel (e10/f10-2, factory Phase 10-11). Nomad's own factory hit a real bug from this
// exact kind of number appearing on two screens computed two different ways and disagreeing
// (docs/factory/PARITY-SPEC.md section 16 item 29) - the fix there, and the rule here, is one
// function every consumer calls, never a second hand-rolled count.
//
// Stages follow the 7-stage model Joel and Claude agreed (docs/factory/ADOPTION-LOG.md decision
// 3: Awareness, Visits, Leads, Nurture, Quote Started, Booked, Loyalty). Only four of the seven
// have ANY code path in this app today - the other three are listed with tracked:false so the
// page says "nothing tracks this yet" rather than a fake zero that looks like a real measurement.
export interface FunnelStage {
  key: string
  label: string
  count: number
  /** false = no code writes this data anywhere yet, not just "zero so far". */
  tracked: boolean
  note: string
}

export interface FunnelResult {
  /** Window length in days; null = all time. */
  days: number | null
  /** Plain words for the window, e.g. "last 28 days" or "all time". Every stage note uses this. */
  windowLabel: string
  revenueCents: number
  /** Visits and leads by page type (lib/conversion.ts). null = the lead pages could not be read. Visits inside are null when visit tracking is off or empty. */
  byPageType: PageTypeFunnelRow[] | null
  visitsByChannel: { channel: string; count: number }[]
  stages: FunnelStage[]
}

/** gsc_ranking_days rows are rolling 28-day totals, so the honest Awareness number is the LATEST
 * row's value, never a sum of several days. Pure so check-wp18 can prove it. */
export function latestRollingImpressions(rows: { day: string; impressions: number | null }[]): number {
  if (!rows.length) return 0
  const latest = rows.reduce((a, b) => (b.day > a.day ? b : a))
  return latest.impressions ?? 0
}

const VISITS_NOT_TRACKED_NOTE =
  "Visit tracking is switched off, so first-party visits are not recorded. The switch is in System health and should be turned on only after your lawyer has approved the cookie wording. GA4 sessions fill this in when GA4 is connected."

/** Pure: the Visits stage. First-party visits (one per session) when tracking is on and rows exist; otherwise GA4 sessions
 * when GA4 answered; otherwise honestly "not tracked". Never a made-up number. */
export function visitsStage(input: { trackingOn: boolean; firstPartyCount: number; ga4Sessions: number | null; windowLabel?: string }): FunnelStage {
  const base = { key: 'visits', label: 'Visits' }
  const win = input.windowLabel ?? 'the last 28 days'
  if (input.trackingOn && input.firstPartyCount > 0) {
    return { ...base, count: input.firstPartyCount, tracked: true, note: `Real visits recorded by this site (one per visit, only from people who accepted analytics), over ${win}. Visitors who declined are not counted, so GA4 may show more.` }
  }
  if (input.ga4Sessions !== null) {
    return { ...base, count: input.ga4Sessions, tracked: true, note: input.trackingOn ? `Visit tracking is on but has recorded no visits yet, so this is GA4 sessions over ${win}.` : `GA4 sessions over ${win} (visit tracking is off).` }
  }
  return {
    ...base,
    count: 0,
    tracked: false,
    note: input.trackingOn ? 'Visit tracking is on but no visits have been recorded yet, and GA4 is not connected.' : VISITS_NOT_TRACKED_NOTE,
  }
}

/** Plain words for a funnel window. Pure. */
export function funnelWindowLabel(days: number | null): string {
  if (days === null) return 'all time'
  if (days === 365) return 'the last 12 months'
  return `the last ${days} days`
}

/** `days` null = all time (no date filter at all). */
export async function getFunnel(admin: SupabaseClient, days: number | null = 28): Promise<FunnelResult> {
  const sinceIso = days === null ? null : new Date(Date.now() - days * 86400000).toISOString()
  const windowLabel = funnelWindowLabel(days)
  // Adds the created_at lower bound only when the window has one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const since = (q: any): any => (sinceIso ? q.gte('created_at', sinceIso) : q)

  // site_visits is written only while the admin switch visit_tracking is on (off by default). It is one row per visit and
  // only grows, so the exact count comes from Postgres COUNT (cheap, no rows transferred) rather than pulling every row into
  // Node; the channel breakdown below is capped at a bounded sample since it's a shape/ratio, not a number that needs to be
  // exact. While tracking is off nothing is read from the table at all (old rows from a past "on" period are not shown).
  const VISIT_SAMPLE_LIMIT = 5000
  const trackingOn = await isVisitTrackingOn(admin)
  const noVisits = Promise.resolve({ count: 0, data: [] as { channel: string | null }[] })
  const [gscRes, visitsCountRes, visitsSampleRes, leadsRes, ordersRes] = await Promise.all([
    // Each row is already a rolling 28-day total (see lib/rankings-snapshot.ts), so read ONLY the latest.
    admin.from('gsc_ranking_days').select('day, impressions').order('day', { ascending: false }).limit(1),
    trackingOn ? since(admin.from('site_visits').select('id', { count: 'exact', head: true })) : noVisits,
    trackingOn ? since(admin.from('site_visits').select('channel, landing_path')).order('created_at', { ascending: false }).limit(VISIT_SAMPLE_LIMIT) : noVisits,
    since(admin.from('leads').select('id', { count: 'exact', head: true }).eq('is_test', false)),
    since(admin.from('orders').select('amount_cents, status, is_test')),
  ])
  // Which page the lead form was on (page_path is stored even without analytics consent). A failed read means "not measured".
  const leadPagesRes = await since(admin.from('leads').select('page_path').eq('is_test', false)).order('created_at', { ascending: false }).limit(VISIT_SAMPLE_LIMIT)

  const impressions = latestRollingImpressions((gscRes.data ?? []) as { day: string; impressions: number | null }[])
  const visitCount = visitsCountRes.count ?? 0
  const visitRows = visitsSampleRes.data ?? []
  // GA4 is the fallback when tracking is off or has recorded nothing. One cached read-only call; a slow or failed answer
  // means "not tracked", never a guess.
  let ga4Sessions: number | null = null
  if (!(trackingOn && visitCount > 0) && isGa4Configured()) {
    try {
      const fetchSessions = async () => (days === null ? (await getGa4RangeReport('all')).totals.sessions : (await getGa4Report(days)).totals.sessions)
      ga4Sessions = await Promise.race([fetchSessions(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GA4 timed out')), 8000))])
    } catch {
      ga4Sessions = null
    }
  }
  type OrderRow = { amount_cents: number | null; status: string; is_test: boolean }
  const realOrders = ((ordersRes.data ?? []) as OrderRow[]).filter((o) => !o.is_test)
  const paidOrders = realOrders.filter((o) => o.status === 'paid')
  const revenueCents = paidOrders.reduce((sum, o) => sum + (o.amount_cents ?? 0), 0)

  const byChannel = new Map<string, number>()
  for (const row of visitRows as { channel: string | null }[]) {
    const key = row.channel || 'unknown'
    byChannel.set(key, (byChannel.get(key) ?? 0) + 1)
  }

  const visitPaths = trackingOn && visitCount > 0 ? (visitRows as { landing_path?: string | null }[]).map((r) => r.landing_path ?? null) : null
  const byPageType = leadPagesRes.error ? null : funnelByPageType(visitPaths, ((leadPagesRes.data ?? []) as { page_path: string | null }[]).map((r) => r.page_path))

  return {
    days,
    windowLabel,
    revenueCents,
    byPageType,
    visitsByChannel: Array.from(byChannel, ([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count),
    stages: [
      {
        key: 'awareness',
        label: 'Awareness (Google Search impressions)',
        count: impressions,
        tracked: true,
        note: 'Always the last 28 days (28-day total from Search Console, it does not follow the range pills): Google impressions from the latest daily Search Console snapshot (one rolling total, never added up across days). Needs CRON_SECRET set and the site verified in Search Console before this fills in.',
      },
      visitsStage({ trackingOn, firstPartyCount: visitCount, ga4Sessions, windowLabel }),
      {
        key: 'leads',
        label: 'Leads (trip inquiries)',
        count: leadsRes.count ?? 0,
        tracked: true,
        note: `Real, live count from every /api/submit-lead call, over ${windowLabel} (test leads excluded).`,
      },
      {
        key: 'nurture',
        label: 'Nurture',
        count: 0,
        tracked: false,
        note: 'No code path exists for this anywhere in the app - it would live in GoHighLevel workflows, not here.',
      },
      {
        key: 'quote_started',
        label: 'Quote Started',
        count: 0,
        tracked: false,
        note: "No code path exists - there's no in-house checkout to open a quote from.",
      },
      {
        key: 'booked',
        label: 'Booked (real orders, test orders excluded)',
        count: paidOrders.length,
        tracked: true,
        note: `Real count over ${windowLabel} from the GoHighLevel purchase webhook - needs GOHIGHLEVEL_WEBHOOK_SECRET set to receive anything.`,
      },
      {
        key: 'loyalty',
        label: 'Loyalty (repeat bookings, referrals, reviews)',
        count: 0,
        tracked: false,
        note: 'No code path exists for this yet.',
      },
    ],
  }
}
