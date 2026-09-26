import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { summarizeOrders, type OrderRow } from '@/lib/orders-summary'

export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const { data, error } = await admin
      .from('orders')
      .select('id, email, package_slug, amount_cents, currency, status, is_test, channel, paid_at, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    const orders = (data ?? []) as OrderRow[]
    return NextResponse.json({ orders, summary: summarizeOrders(orders) })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
