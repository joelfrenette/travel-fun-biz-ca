import type { SupabaseClient } from '@supabase/supabase-js'
import { buildValueReport, type ValueReport } from '@/lib/value'
import { collectValueData } from '@/lib/value-data'

// Monthly snapshot of the Website Value page, run from the pipeline's housekeeping (no new cron).
// Once per calendar month it freezes the tiles and the estimate into value_snapshots so history
// cannot be rewritten, and upserts the numeric tiles into value_metrics. Aggregates only.

/** YYYY-MM for a date. Pure. */
export const snapshotPeriod = (now: Date) => now.toISOString().slice(0, 7)

/** The rows to store for a report. Pure, so the check can prove they hold no personal data. */
export function snapshotRows(report: ValueReport, period: string) {
  const metrics = report.tiles.map((t) => ({ key: t.key, label: t.label, value: t.value, raw: t.raw, source: t.source, as_of: t.asOf, status: t.status }))
  return {
    snapshot: { period, metrics, estimate: report.estimate },
    metricRows: report.tiles
      .filter((t) => t.raw != null)
      .map((t) => ({ metric_key: t.key, period, value: t.raw, source: t.source, computed_at: report.generatedAt })),
  }
}

/** Take this month's snapshot if it does not exist yet. Returns a note when it wrote one, else null.
 * Never throws: a missing table (migration 0045 not applied) or any other problem returns null. */
export async function runValueSnapshotIfDue(admin: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  try {
    const period = snapshotPeriod(now)
    const existing = await admin.from('value_snapshots').select('period').eq('period', period).maybeSingle()
    if (existing.error || existing.data) return null
    const report = buildValueReport(await collectValueData(admin, now), now)
    const { snapshot, metricRows } = snapshotRows(report, period)
    // period is the primary key, so a second pass racing this one simply fails its insert.
    const ins = await admin.from('value_snapshots').insert(snapshot)
    if (ins.error) return null
    if (metricRows.length) await admin.from('value_metrics').upsert(metricRows, { onConflict: 'metric_key,period' })
    return `Website Value snapshot saved for ${period}.`
  } catch {
    return null
  }
}
