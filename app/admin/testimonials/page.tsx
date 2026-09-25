"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, Plus, Trash2, Star } from "lucide-react"
import type { Testimonial, TestimonialInput } from "@/lib/testimonials"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const emptyForm: TestimonialInput = { author: "", location: "", trip_name: "", rating: 5, text: "", source: "", status: "published", featured: false }

export default function TestimonialsAdminPage() {
  const [rows, setRows] = useState<Testimonial[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [form, setForm] = useState<TestimonialInput>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [rowSaving, setRowSaving] = useState<Record<string, boolean>>({})

  function load() {
    setLoading(true)
    fetch("/api/admin/testimonials", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || "Could not load")
        setRows(data.testimonials || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function add() {
    setSaving(true); setError("")
    try {
      const res = await fetch("/api/admin/testimonials", { method: "POST", headers: authHeaders(), body: JSON.stringify({ ...form, sort_order: rows.length }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setRows((rs) => [...rs, data.testimonial])
      setForm(emptyForm)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add")
    } finally {
      setSaving(false)
    }
  }

  async function patch(row: Testimonial, changes: TestimonialInput) {
    setRowSaving((s) => ({ ...s, [row.id]: true }))
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...changes } : r)))
    try {
      const res = await fetch(`/api/admin/testimonials/${row.id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(changes) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
      load()
    } finally {
      setRowSaving((s) => ({ ...s, [row.id]: false }))
    }
  }

  async function remove(row: Testimonial) {
    if (!confirm(`Remove the testimonial from ${row.author}?`)) return
    const res = await fetch(`/api/admin/testimonials/${row.id}`, { method: "DELETE", headers: authHeaders() })
    if (res.ok) setRows((rs) => rs.filter((r) => r.id !== row.id))
    else setError((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">Testimonials</h1>
          <p className="text-sm text-muted-foreground">One shared pool for the homepage today, trip pages and recap pages later. Draft rows never show on the site.</p>
        </div>
      </div>

      <div className="container mx-auto space-y-4 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5"><Label>Author</Label><Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="Jane Smith" /></div>
            <div className="space-y-1.5"><Label>Source</Label><Input value={form.source ?? ""} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="Google Review" /></div>
            <div className="space-y-1.5"><Label>Trip</Label><Input value={form.trip_name ?? ""} onChange={(e) => setForm({ ...form, trip_name: e.target.value })} placeholder="Croatia Coastline Yacht Cruise" /></div>
            <div className="space-y-1.5">
              <Label>Rating</Label>
              <Select value={String(form.rating ?? 5)} onValueChange={(v) => setForm({ ...form, rating: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{[5, 4, 3, 2, 1].map((n) => <SelectItem key={n} value={String(n)}>{n} star{n === 1 ? "" : "s"}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>Text</Label><Textarea rows={2} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} /></div>
            <div className="flex items-end">
              <Button className="w-full" onClick={add} disabled={saving || !form.author?.trim() || !form.text?.trim()}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}Add
              </Button>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <Card key={row.id}>
                <CardContent className="flex flex-wrap items-start gap-4 p-4">
                  <div className="min-w-[220px] flex-1">
                    <div className="flex items-center gap-2 font-medium">
                      {row.author}
                      <span className="flex">{Array.from({ length: row.rating }).map((_, i) => <Star key={i} className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{row.source}{row.trip_name ? ` · ${row.trip_name}` : ""}</p>
                    <p className="mt-2 text-sm text-muted-foreground">{row.text}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={row.status} onValueChange={(v) => patch(row, { status: v as "draft" | "published" })} disabled={!!rowSaving[row.id]}>
                      <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="published">Published</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(row)} title="Remove"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {rows.length === 0 && <div className="py-12 text-center text-muted-foreground">No testimonials yet.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
