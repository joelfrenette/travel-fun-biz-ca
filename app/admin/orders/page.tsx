"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Receipt } from "lucide-react"
import { formatCents, type OrderRow, type OrdersSummary } from "@/lib/orders-summary"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [summary, setSummary] = useState<OrdersSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/admin/orders", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setOrders(data.orders || [])
        setSummary(data.summary || null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Orders</h1>
          <p className="text-sm text-muted-foreground">Purchases GoHighLevel has reported. Test purchases and refunds are shown but never counted in the total.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Receipt className="h-8 w-8" />
            <p>No orders yet.</p>
            <p className="max-w-md text-sm">
              This fills in once <code className="rounded bg-muted px-1">GOHIGHLEVEL_WEBHOOK_SECRET</code> is set and a GoHighLevel workflow is pointed at the purchase webhook. See the setup checklist for the exact steps.
            </p>
          </div>
        ) : (
          <>
            {summary && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-2xl font-bold">{formatCents(summary.totalCents, summary.currency)}</p>
                    <p className="text-xs text-muted-foreground">Total collected</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-2xl font-bold">{summary.orderCount}</p>
                    <p className="text-xs text-muted-foreground">Real orders</p>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card>
              <CardContent className="p-0">
                {orders.map((o) => (
                  <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 border-t p-4 first:border-t-0">
                    <div className="min-w-[220px] flex-1">
                      <p className="font-medium">{o.package_slug ?? "(no package)"}</p>
                      <p className="text-xs text-muted-foreground">
                        {o.email ?? "unknown email"} &middot; {o.channel ?? "unknown channel"} &middot; {o.paid_at ? new Date(o.paid_at).toLocaleDateString("en-CA") : new Date(o.created_at).toLocaleDateString("en-CA")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {o.is_test && <Badge variant="secondary">test</Badge>}
                      <Badge variant={o.status === "paid" ? "default" : "destructive"}>{o.status}</Badge>
                      <span className="font-medium">{formatCents(o.amount_cents, o.currency)}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
