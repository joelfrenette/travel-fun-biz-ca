// Ported from Nomad Escape Plan's lib/purchase-value.ts (Factory Phase 4: leads/CRM), trimmed to
// the one genuinely reusable function. Dropped Nomad's own product-pricing lookups entirely -
// this site has no affiliate/commission program yet (that's Phase 7 in the roadmap tracker), so
// there's nothing to call this from today. It's ported now anyway because it's the direct
// implementation of an owner rule stated up front for this whole program: "commission is on
// money collected, never list price" - so whichever phase builds the affiliate layer has this
// ready rather than needing to (re)derive the same math under deadline.
import type { OrderInput } from '@/lib/purchase-ledger'

/**
 * The commission base for one package's share of an order: what was actually collected, net of
 * tax, pro-rated by this package's share of the order's subtotal, and never more than the
 * package's own list price (a coupon can only lower the base, never inflate it).
 */
export function collectedBaseCents(
  listPriceCents: number,
  order: Pick<OrderInput, 'amount_cents' | 'tax_cents' | 'subtotal_cents'>,
): number {
  const net = order.amount_cents - (order.tax_cents ?? 0)
  if (!order.subtotal_cents || order.subtotal_cents <= 0) {
    return Math.min(Math.max(net, 0), listPriceCents)
  }
  const share = Math.min(listPriceCents / order.subtotal_cents, 1)
  return Math.min(Math.max(Math.round(net * share), 0), listPriceCents)
}
