// Factory Phase 9: a real admin view of Phase 4's orders ledger. That phase built the write
// side (the GHL webhook + recordOrder) but never gave Joel anywhere to see it once purchases
// start flowing in - this closes that gap.
export interface OrderRow {
  id: string
  email: string | null
  package_slug: string | null
  amount_cents: number
  currency: string
  status: 'paid' | 'refunded'
  is_test: boolean
  channel: string | null
  paid_at: string | null
  created_at: string
}

export interface OrdersSummary {
  orderCount: number
  totalCents: number
  currency: string
}

/** Test purchases never count toward revenue - same "excluded from the dashboard" rule
 * PARITY-SPEC calls for. Refunded orders don't count either; a refund isn't revenue. */
export function summarizeOrders(orders: Pick<OrderRow, 'amount_cents' | 'currency' | 'status' | 'is_test'>[]): OrdersSummary {
  const real = orders.filter((o) => !o.is_test && o.status === 'paid')
  return {
    orderCount: real.length,
    totalCents: real.reduce((sum, o) => sum + o.amount_cents, 0),
    currency: real[0]?.currency ?? 'CAD',
  }
}

export function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `$${(cents / 100).toFixed(2)}`
  }
}
