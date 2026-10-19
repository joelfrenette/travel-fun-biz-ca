// Offline check: orders are attributed to the buyer's first-touch lead channel by email.
// Run: pnpm dlx tsx scripts/check-order-attribution.ts   (exit 1 on a failure)
import { pickLeadAttribution, recordOrder, type OrderInput } from '../lib/purchase-ledger'

let failures = 0
const out: string[] = []
function expect(name: string, ok: boolean) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const EMAIL = 'buyer.person@example.org'
const none = {}
const ghlUtm = { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'ghl-camp' }
const lead = { utm_source: 'google', utm_medium: 'organic', utm_campaign: 'lead-camp', utm_content: null, page_path: '/guides/cancun' }

{
  const r = pickLeadAttribution(lead, ghlUtm)
  expect('GHL utm wins, lead ignored', r.basis === 'ghl_custom_data' && r.utm.utm_campaign === 'ghl-camp' && r.utm.utm_source === 'facebook')
}
{
  const r = pickLeadAttribution(lead, none)
  expect('lead utm used with basis lead_email_match', r.basis === 'lead_email_match' && r.utm.utm_source === 'google' && r.utm.utm_campaign === 'lead-camp')
  expect('channel classified', r.channel === 'search')
  expect('empty utm_content filled with page_path', r.utm.utm_content === '/guides/cancun')
}
{
  const r = pickLeadAttribution({ ...lead, utm_content: 'hero-cta' }, none)
  expect('existing utm_content kept over page_path', r.utm.utm_content === 'hero-cta')
}
{
  const r = pickLeadAttribution({ utm_source: null, utm_medium: null, page_path: '/x' }, none)
  expect('lead without utm gives no attribution', r.basis === 'none' && r.channel === null)
}
{
  const r = pickLeadAttribution(null, none)
  expect('null lead gives today result', r.basis === 'none' && r.channel === null && r.channelSource === null)
}

function order(attr: OrderInput['ghl_attribution'], email: string | null): OrderInput {
  return {
    provider: 'ghl', provider_order_id: 't1', email, ghl_contact_id: null, status: 'paid', is_test: false,
    amount_cents: 100, subtotal_cents: null, discount_cents: null, tax_cents: null, currency: 'USD',
    coupon_code: null, gateway: null, payment_source: null, package_slug: null, items: [], paid_at: null, ghl_attribution: attr,
  }
}

// Fake client: leads query returns/throws as told; orders upsert captures the row.
function fake(mode: 'lead' | 'throw' | 'error' | 'empty') {
  const state: { row: Record<string, unknown> | null; leadQueries: number } = { row: null, leadQueries: 0 }
  const client = {
    from(table: string) {
      if (table === 'orders') {
        return { upsert: async (row: Record<string, unknown>) => { state.row = row; return { error: null } } }
      }
      state.leadQueries++
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'ilike', 'eq', 'order']) q[m] = () => q
      q.limit = async () => {
        if (mode === 'throw') throw new Error('boom')
        if (mode === 'error') return { data: null, error: { message: 'x' } }
        if (mode === 'empty') return { data: [], error: null }
        return { data: [lead], error: null }
      }
      return q
    },
  }
  return { client: client as never, state }
}

async function main() {
  {
    const f = fake('lead')
    await recordOrder(f.client, order({}, EMAIL), null)
    expect('recordOrder uses lead values', f.state.row?.attribution_basis === 'lead_email_match' && f.state.row?.utm_source === 'google' && f.state.row?.channel === 'search')
    expect('recordOrder fills utm_content from page_path', f.state.row?.utm_content === '/guides/cancun')
  }
  {
    const f = fake('lead')
    await recordOrder(f.client, order(ghlUtm, EMAIL), null)
    expect('recordOrder with GHL utm does not query leads', f.state.leadQueries === 0 && f.state.row?.attribution_basis === 'ghl_custom_data')
  }
  for (const mode of ['throw', 'error', 'empty'] as const) {
    const f = fake(mode)
    const res = await recordOrder(f.client, order({}, EMAIL), null)
    expect(`lead read ${mode} falls back to basis none`, !res.error && f.state.row?.attribution_basis === 'none' && f.state.row?.utm_source === null && f.state.row?.channel === null)
  }
  {
    const f = fake('lead')
    await recordOrder(f.client, order({}, null), null)
    expect('no email skips lead lookup', f.state.leadQueries === 0 && f.state.row?.attribution_basis === 'none')
  }

  const text = out.join('\n')
  expect('output contains no email strings', !/@/.test(text) && !text.includes(EMAIL))
  console.log(text)
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
main()
