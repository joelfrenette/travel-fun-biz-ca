import type { ValueReport } from '@/lib/value'

// Aggregate-only CSV for a buyer's data room. It is built from the report's tiles, estimate and
// monthly revenue only: no lead rows, no emails, no names. Free text the owner typed (risks) is
// scrubbed of anything that looks like an email address or phone number before it is written.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE = /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}|\b\d{10,11}\b/g

/** Replace email addresses and phone-like numbers. Pure. */
export function scrubPersonal(text: string): string {
  return text.replace(EMAIL, '[removed]').replace(PHONE, '[removed]')
}

/** One CSV cell: scrubbed, quoted, and defanged against spreadsheet formulas. Pure. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? '' : typeof v === 'number' ? String(v) : scrubPersonal(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildDataRoomCsv(report: ValueReport): string {
  const rows: (string | number | null)[][] = [['section', 'item', 'value', 'source', 'as_of', 'note']]
  rows.push(['meta', 'generated_at', report.generatedAt, 'Website Value page', report.generatedAt.slice(0, 10), 'Aggregates only. No lead rows, no emails.'])
  for (const t of report.tiles) {
    rows.push(['metric', t.label, t.value ?? 'Not tracked', t.source, t.asOf, t.note])
  }
  const e = report.estimate
  rows.push(['estimate', 'label', e.label, '', '', ''])
  rows.push(['estimate', 'status', e.status, '', '', e.reason])
  rows.push(['estimate', 'low', e.low, '', '', e.currency])
  rows.push(['estimate', 'base', e.base, '', '', e.currency])
  rows.push(['estimate', 'high', e.high, '', '', e.currency])
  rows.push(['estimate', 'multiple_low', e.multipleLow, 'editable', '', ''])
  rows.push(['estimate', 'multiple_high', e.multipleHigh, 'editable', '', ''])
  for (const a of e.adjustments) rows.push(['adjustment', a.label, a.value, a.source, '', a.reason])
  for (const a of e.assumptions) rows.push(['assumption', a, '', '', '', ''])
  for (const m of report.monthlyRevenue) rows.push(['monthly_revenue', m.month, m.amount, 'Orders ledger', m.month, ''])
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
