import type { SupabaseClient } from '@supabase/supabase-js'

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
  days: number
  revenueCents: number
  visitsByChannel: { channel: string; count: number }[]
  stages: FunnelStage[]
}

export async function getFunnel(admin: SupabaseClient, days = 28): Promise<FunnelResult> {
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString()
  const sinceDay = sinceIso.slice(0, 10)

  const [gscRes, visitsRes, leadsRes, ordersRes] = await Promise.all([
    admin.from('gsc_ranking_days').select('impressions').gte('day', sinceDay),
    admin.from('site_visits').select('channel').gte('created_at', sinceIso),
    admin.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso),
    admin.from('orders').select('amount_cents, status, is_test').gte('created_at', sinceIso),
  ])

  const impressions = (gscRes.data ?? []).reduce((sum, r: { impressions: number | null }) => sum + (r.impressions ?? 0), 0)
  const visitRows = visitsRes.data ?? []
  const realOrders = (ordersRes.data ?? []).filter((o: { is_test: boolean }) => !o.is_test)
  const paidOrders = realOrders.filter((o: { status: string }) => o.status === 'paid')
  const revenueCents = paidOrders.reduce((sum, o: { amount_cents: number | null }) => sum + (o.amount_cents ?? 0), 0)

  const byChannel = new Map<string, number>()
  for (const row of visitRows as { channel: string | null }[]) {
    const key = row.channel || 'unknown'
    byChannel.set(key, (byChannel.get(key) ?? 0) + 1)
  }

  return {
    days,
    revenueCents,
    visitsByChannel: Array.from(byChannel, ([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count),
    stages: [
      {
        key: 'awareness',
        label: 'Awareness (Google Search impressions)',
        count: impressions,
        tracked: true,
        note: 'From the daily Search Console snapshot cron - needs CRON_SECRET set and the site verified in Search Console before this fills in.',
      },
      {
        key: 'visits',
        label: 'Visits',
        count: visitRows.length,
        tracked: false,
        note: "No code writes to site_visits yet. It only reads UTM/referrer into the visitor's own browser storage today, waiting on the cookie-consent wording (setup checklist, Part 6) before a real visit can be recorded server-side.",
      },
      {
        key: 'leads',
        label: 'Leads (trip inquiries)',
        count: leadsRes.count ?? 0,
        tracked: true,
        note: 'Real, live count from every /api/submit-lead call.',
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
        note: 'Real count from the GoHighLevel purchase webhook - needs GOHIGHLEVEL_WEBHOOK_SECRET set to receive anything.',
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
