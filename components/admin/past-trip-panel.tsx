"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"
import { Loader2, Upload, Plus, X, Undo2, Check, Pencil } from "lucide-react"

// "Convert to Past Trip" (growth loop WP14). A past trip is never unpublished: its page keeps its address, title and
// text, and gains a recap, the trip's photos and a "tell me about the next one" signup. Four steps in one card:
// (1) the mode, (2) photos and journal notes, (3) Write the recap, (4) the next trip and the alert tag.
// "Write the recap" publishes at once when the quality checks pass; "Undo recap" puts the earlier state back.

const BUCKET = "package-sources"
const SERVER_UPLOAD_MAX = 4 * 1024 * 1024

interface Journal { date: string; title: string; body: string }
interface Photo { id: string; file_name: string | null; preview_url: string | null; added: boolean; stored: string | null }
interface Choice { slug: string; name: string; category: string; available_from: string | null }
interface Draft { summary: string; highlights: string[]; blockers: string[]; at: string }
interface State {
  migrated: boolean
  mode: "auto" | "recap" | "live"
  isPast: boolean
  hasRecap: boolean
  summary: string
  highlights: string[]
  generatedAt: string | null
  draft: Draft | null
  nextTripSlug: string
  alertTag: string
  defaultAlertTag: string
  effectiveAlertTag: string
  journal: Journal[]
  notesUsable: number
  notesNeeded: number
  galleryCount: number
  photos: Photo[]
  maxPhotos: number
  choices: Choice[]
  slug: string
}

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

const MODE_TEXT: Record<State["mode"], { label: string; help: string }> = {
  auto: { label: "Automatic", help: "The page turns into a recap by itself once the last date has passed." },
  recap: { label: "Recap now", help: "Show the recap layout even if the dates have not passed." },
  live: { label: "Keep it live", help: "Keep the normal bookable layout even though the dates have passed (for a trip that runs again)." },
}

export function PastTripPanel({ packageId, onChanged }: { packageId: string; onChanged?: () => void }) {
  const { toast } = useToast()
  const [s, setS] = useState<State | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [journal, setJournal] = useState<Journal[]>([])
  const [dirtyJournal, setDirtyJournal] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editSummary, setEditSummary] = useState("")
  const [editHighlights, setEditHighlights] = useState("")
  const [editBlockers, setEditBlockers] = useState<string[]>([])
  const [alertTag, setAlertTag] = useState("")
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/recap`, { headers: authHeaders(false) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Could not load (HTTP ${res.status})`)
      setS(body)
      setAlertTag(body.alertTag ?? "")
      setJournal((prev) => (dirtyJournal ? prev : (body.journal ?? [])))
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    }
  }, [packageId, dirtyJournal])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId])

  async function post(body: Record<string, unknown>, label: string) {
    const res = await fetch(`/api/admin/packages/${packageId}/recap`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(out.error || `${label} failed (HTTP ${res.status})`) as Error & { blockers?: string[] }
      err.blockers = out.blockers
      throw err
    }
    return out
  }

  async function run(key: string, label: string, fn: () => Promise<void>) {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toast({ title: `${label} did not work`, description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      await load()
    }
  }

  const saveSettings = (patch: Record<string, unknown>, label: string) =>
    run("settings", label, async () => {
      await post({ action: "settings", ...patch }, label)
      toast({ title: `${label} saved` })
      onChanged?.()
    })

  async function uploadPhoto(file: File) {
    if (file.size <= SERVER_UPLOAD_MAX) {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(false), body: form })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Upload failed (HTTP ${res.status})`)
      return
    }
    const prepRes = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "upload-url" }) })
    const prep = await prepRes.json().catch(() => ({}))
    if (!prepRes.ok) throw new Error(prep.error || "Could not prepare the upload")
    const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined })
    if (up.error) throw new Error(up.error.message)
    const regRes = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "register", path: prep.path, name: file.name }) })
    const reg = await regRes.json().catch(() => ({}))
    if (!regRes.ok) throw new Error(reg.error || "Could not add the photo")
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (list.length === 0) return
    await run("upload", "Adding photos", async () => {
      let ok = 0
      const problems: string[] = []
      for (const f of list) {
        try {
          await uploadPhoto(f)
          ok++
        } catch (e) {
          problems.push(`${f.name}: ${e instanceof Error ? e.message : "failed"}`)
        }
      }
      toast({ title: `Added ${ok} photo${ok === 1 ? "" : "s"}`, description: problems.length ? problems.slice(0, 3).join(" | ") : "Now use Add to gallery on the ones you want on the page.", variant: problems.length && !ok ? "destructive" : undefined })
    })
  }

  async function addToGallery(p: Photo) {
    await run(`gal:${p.id}`, "Adding to the gallery", async () => {
      await post({ action: "photo-add", sourceId: p.id }, "Adding to the gallery")
      toast({ title: "Added to the gallery" })
      onChanged?.()
    })
  }

  async function undoPhoto(p: Photo) {
    await run(`unalbum:${p.id}`, "Undo", async () => {
      const res = await fetch(`/api/admin/packages/${packageId}/sources/${p.id}/revert`, { method: "POST", headers: authHeaders() })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`)
      toast({ title: "Taken out of the gallery" })
      onChanged?.()
    })
  }

  async function deletePhoto(p: Photo) {
    if (!confirm("Delete this photo from the private store?")) return
    await run(`del:${p.id}`, "Deleting the photo", async () => {
      const res = await fetch(`/api/admin/packages/${packageId}/recap/photos?sourceId=${p.id}`, { method: "DELETE", headers: authHeaders(false) })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`)
    })
  }

  async function saveJournal() {
    await run("journal", "Journal notes", async () => {
      await post({ action: "settings", journal_entries: journal }, "Journal notes")
      setDirtyJournal(false)
      toast({ title: "Journal notes saved" })
      onChanged?.()
    })
  }

  async function writeRecap() {
    if (dirtyJournal) {
      toast({ title: "Save your journal notes first", description: "The recap is written from the saved notes.", variant: "destructive" })
      return
    }
    await run("write", "Writing the recap", async () => {
      const r = await post({ action: "write" }, "Writing the recap")
      if (r.published) toast({ title: "Recap written and published", description: "It is live on the trip page. Use Edit to change the words or Undo recap to take it back." })
      else toast({ title: "Recap written but held back", description: "The checks did not pass, so it is not on the page. The reasons are shown below.", variant: "destructive" })
      onChanged?.()
    })
  }

  async function saveEdit() {
    await run("edit", "Saving the edit", async () => {
      try {
        await post({ action: "edit", summary: editSummary, highlights: editHighlights }, "Saving the edit")
      } catch (e) {
        setEditBlockers((e as Error & { blockers?: string[] }).blockers ?? [])
        throw e
      }
      setEditing(false)
      setEditBlockers([])
      toast({ title: "Recap updated" })
      onChanged?.()
    })
  }

  async function undo() {
    if (!confirm("Put the page back the way it was before the recap?")) return
    await run("undo", "Undo recap", async () => {
      const r = await post({ action: "undo" }, "Undo recap")
      const left = (r.skipped ?? []) as { field: string; reason: string }[]
      toast({ title: "Recap taken off the page", description: left.length ? `Left alone: ${left.map((x) => x.field).join(", ")}` : undefined })
      onChanged?.()
    })
  }

  if (error) return <Card className="mx-auto mb-4 max-w-4xl"><CardContent className="p-4 text-sm text-red-700">{error}</CardContent></Card>
  if (!s) return <Card className="mx-auto mb-4 max-w-4xl"><CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading the past trip card</CardContent></Card>

  const enoughNotes = s.notesUsable >= s.notesNeeded
  const hasText = s.summary.trim().length > 0

  return (
    <Card className="mx-auto mb-4 max-w-4xl" id="past-trip-panel">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Convert to Past Trip
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.isPast ? "bg-sky-100 text-sky-800" : "bg-emerald-100 text-emerald-800"}`}>{s.isPast ? "Showing as a past trip" : "Showing as a live trip"}</span>
          {s.isPast && !hasText && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">Needs a recap</span>}
        </CardTitle>
        <CardDescription>
          A past trip is never unpublished. The page keeps its address, title and text, and gains a recap, your photos and a sign-up for the next trip like it.
          {!s.migrated && <span className="mt-1 block font-medium text-red-700">One database update is missing: run migration 0037 (supabase/migrations/0037_trip_recap.sql) in the Supabase SQL editor first.</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {/* 1 mode */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">1. How should the page behave?</h3>
          <div className="space-y-1.5">
            {(Object.keys(MODE_TEXT) as State["mode"][]).map((m) => (
              <label key={m} className="flex cursor-pointer items-start gap-2 text-sm">
                <input type="radio" name={`recap-mode-${packageId}`} className="mt-1" checked={s.mode === m} disabled={busy === "settings"} onChange={() => saveSettings({ recap_mode: m }, "Page mode")} />
                <span><span className="font-medium">{MODE_TEXT[m].label}.</span> <span className="text-muted-foreground">{MODE_TEXT[m].help}</span></span>
              </label>
            ))}
          </div>
        </section>

        {/* 2 photos + journal */}
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">2. Your photos and journal notes</h3>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
            className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center text-sm ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
          >
            <Upload className="h-5 w-5 text-muted-foreground" />
            <p>Drop photos from the trip here (up to {s.maxPhotos}). These are your own pictures, so they may go on the page.</p>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = "" }} />
            <Button type="button" variant="outline" size="sm" disabled={busy === "upload" || s.photos.length >= s.maxPhotos} onClick={() => fileInput.current?.click()}>
              {busy === "upload" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Adding</> : "Choose photos"}
            </Button>
            <p className="text-xs text-muted-foreground">Kept private until you press Add to gallery. The page shows at most 12 gallery photos; {s.galleryCount} there now.</p>
          </div>
          {s.photos.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {s.photos.map((p) => (
                <div key={p.id} className="space-y-1.5 rounded-lg border p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.preview_url ? <img src={p.preview_url} alt={p.file_name ?? "Trip photo"} className="h-24 w-full rounded object-cover" /> : <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">No preview</div>}
                  <p className="truncate text-xs text-muted-foreground">{p.file_name}</p>
                  {p.added ? (
                    <Button type="button" size="sm" variant="outline" className="w-full" disabled={busy === `unalbum:${p.id}`} onClick={() => undoPhoto(p)}><Undo2 className="mr-1 h-3.5 w-3.5" />Take out</Button>
                  ) : (
                    <div className="flex gap-1">
                      <Button type="button" size="sm" className="flex-1" disabled={busy === `gal:${p.id}`} onClick={() => addToGallery(p)}>{busy === `gal:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add to gallery"}</Button>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Delete photo" disabled={busy === `del:${p.id}`} onClick={() => deletePhoto(p)}><X className="h-4 w-4" /></Button>
                    </div>
                  )}
                  {p.added && <p className="text-xs font-medium text-emerald-700">In the gallery</p>}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Journal notes: 3 to 8 short entries, a date and a line or two about what happened. They show on the page, and the recap is written only from them. ({s.notesUsable} usable now, {s.notesNeeded} needed.)</p>
            {journal.map((entry, idx) => (
              <div key={idx} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                      <Input type="date" value={entry.date} onChange={(e) => { setJournal(journal.map((x, i) => (i === idx ? { ...x, date: e.target.value } : x))); setDirtyJournal(true) }} />
                      <Input placeholder="Title (e.g. Day 3: Arrived in Split)" value={entry.title} onChange={(e) => { setJournal(journal.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x))); setDirtyJournal(true) }} />
                    </div>
                    <Textarea placeholder="What happened this day..." rows={2} value={entry.body} onChange={(e) => { setJournal(journal.map((x, i) => (i === idx ? { ...x, body: e.target.value } : x))); setDirtyJournal(true) }} />
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove note" onClick={() => { setJournal(journal.filter((_, i) => i !== idx)); setDirtyJournal(true) }}><X className="h-4 w-4" /></Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => { setJournal([...journal, { date: "", title: "", body: "" }]); setDirtyJournal(true) }}><Plus className="mr-1 h-4 w-4" />Add a note</Button>
              <Button type="button" size="sm" disabled={!dirtyJournal || busy === "journal"} onClick={saveJournal}>{busy === "journal" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save notes"}</Button>
            </div>
          </div>
        </section>

        {/* 3 recap */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">3. The recap</h3>
          <p className="text-sm text-muted-foreground">One AI call writes a short past-tense recap from your notes and the page text, then plain-code checks look for invented numbers, prices, dates, superlatives and made-up names. If it passes it goes live straight away. If not, it stays off the page and the reasons are listed.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy === "write" || !enoughNotes || !s.migrated} onClick={writeRecap}>
              {busy === "write" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Writing</> : hasText ? "Write it again" : "Write the recap"}
            </Button>
            {hasText && !editing && <Button type="button" variant="outline" onClick={() => { setEditSummary(s.summary); setEditHighlights(s.highlights.join("\n")); setEditBlockers([]); setEditing(true) }}><Pencil className="mr-1 h-4 w-4" />Edit</Button>}
            {s.hasRecap && <Button type="button" variant="outline" disabled={busy === "undo"} onClick={undo}><Undo2 className="mr-1 h-4 w-4" />Undo recap</Button>}
          </div>
          {!enoughNotes && <p className="text-xs text-amber-700">Add at least {s.notesNeeded} journal notes (and save them) to enable this button.</p>}

          {s.draft && (
            <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-semibold">A recap was written but is NOT on the page. The checks held it back:</p>
              <ul className="list-disc pl-5">{s.draft.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              <p className="whitespace-pre-line rounded bg-white/70 p-2 text-foreground">{s.draft.summary}</p>
              <p className="text-xs">Fix your notes and write it again, or copy the text, fix the part named above, and use Edit.</p>
            </div>
          )}

          {editing ? (
            <div className="space-y-2 rounded-lg border p-3">
              <Textarea rows={8} value={editSummary} onChange={(e) => setEditSummary(e.target.value)} />
              <p className="text-xs text-muted-foreground">Highlights, one per line:</p>
              <Textarea rows={5} value={editHighlights} onChange={(e) => setEditHighlights(e.target.value)} />
              {editBlockers.length > 0 && <ul className="list-disc pl-5 text-sm text-red-700">{editBlockers.map((b) => <li key={b}>{b}</li>)}</ul>}
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={busy === "edit"} onClick={saveEdit}>{busy === "edit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-1 h-4 w-4" />Save and publish</>}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            hasText && (
              <div className="space-y-2 rounded-lg border bg-emerald-50/50 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">On the page now{s.generatedAt ? `, written ${new Date(s.generatedAt).toLocaleDateString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium" })}` : ""}</p>
                <p className="whitespace-pre-line">{s.summary}</p>
                {s.highlights.length > 0 && <ul className="list-disc pl-5">{s.highlights.map((h) => <li key={h}>{h}</li>)}</ul>}
              </div>
            )
          )}
        </section>

        {/* 4 next trip + alert */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">4. The next trip and the alert tag</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium">"Join the next trip" points to</span>
              <select className="w-full rounded-md border bg-background p-2 text-sm" value={s.nextTripSlug} disabled={busy === "settings"} onChange={(e) => saveSettings({ next_trip_slug: e.target.value }, "Next trip")}>
                <option value="">The soonest upcoming trip in the same category</option>
                {s.choices.map((c) => <option key={c.slug} value={c.slug}>{c.name}{c.available_from ? ` (${c.available_from})` : ""}</option>)}
              </select>
            </label>
            <div className="space-y-1 text-sm">
              <label htmlFor={`alert-tag-${packageId}`} className="font-medium">Alert tag (GoHighLevel)</label>
              <div className="flex gap-2">
                <Input id={`alert-tag-${packageId}`} placeholder={s.defaultAlertTag} value={alertTag} onChange={(e) => setAlertTag(e.target.value)} />
                <Button type="button" variant="outline" disabled={busy === "settings" || alertTag === s.alertTag} onClick={() => saveSettings({ alert_tag: alertTag }, "Alert tag")}>Save</Button>
              </div>
              <p className="text-xs text-muted-foreground">People who ask to hear about the next one get this tag. In use: <code>{s.effectiveAlertTag}</code>{s.alertTag ? "" : " (the default for this category)"}.</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Public page: <a className="underline" href={`/packages/${s.slug}`} target="_blank" rel="noreferrer">/packages/{s.slug}</a></p>
        </section>
      </CardContent>
    </Card>
  )
}
