"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { supabase } from "@/integrations/supabase/client"
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Loader2, MessageCircle, Mic, Send, Star, Undo2, Upload, X } from "lucide-react"
import { altTextFor, laplacianVariance, pickBestPhotos, QUESTIONS, GALLERY_PICK, type PhotoFacts } from "@/lib/recap-studio"

// The Recap Studio: a short wizard that turns a trip that already happened into a good recap page. Four steps (Photos, Five
// questions, Quotes, Preview and publish), a progress ring and a Recap score that goes up as things are added, and a box for
// what a travel agent or traveller sent through a link (it waits here until you approve it). Nothing is invented: the draft is
// written only from the notes and the trip record, and every sentence shows where it came from.

const BUCKET = "package-sources"
const SERVER_UPLOAD_MAX = 4 * 1024 * 1024

function authHeaders(json = true): HeadersInit {
  const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
  if (json) h["Content-Type"] = "application/json"
  return h
}

interface Photo { id: string; file_name: string | null; preview_url: string | null; added: boolean }
interface Pending { id: string; kind: "answers" | "quote" | "photo"; by: string | null; at: string; summary: string; payload: Record<string, unknown>; previewUrl: string | null }
interface Share { id: string; kind: "agent" | "testimonial"; agent_name: string | null; created_at: string; expires_at: string; revoked_at: string | null; uses: number; state: { ok: boolean; reason?: string } }
interface Traced { sentence: string; source: string | null; support: number }
interface View {
  migrated: boolean
  trip: { id: string; name: string; slug: string; destination: string; available_to: string | null; isPast: boolean; hasRecap: boolean; summary: string }
  studio: { answers: Record<string, string>; photoOrder: string[]; coverId: string | null; quotes: { id: string; text: string; name: string }[] }
  photos: Photo[]
  photoOrder: string[]
  pending: Pending[]
  shares: Share[]
  draft: { draft: { summary: string; highlights: string[]; faqs: { question: string; answer: string }[]; takeaways: string[]; metaTitle: string; metaDescription: string }; blockers: string[]; at: string; edited: boolean } | null
  trace: { summary: Traced[]; highlights: Traced[]; faqs: { question: string; answer: Traced[] }[]; takeaways: Traced[] } | null
  quotes: { text: string; name: string }[]
  bundle: { publishedAt: string } | null
  score: { now: number; after: number; items: { id: string; label: string; done: boolean; points: number }[]; thin: boolean }
  thin: { before: number; after: number }
}

const STEPS = ["Photos", "Five questions", "Quotes", "Preview and publish"]

function Ring({ value }: { value: number }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 shrink-0" role="img" aria-label={`Recap score ${value} out of 100`}>
      <circle cx="40" cy="40" r={r} fill="none" strokeWidth="8" className="stroke-muted" />
      <circle cx="40" cy="40" r={r} fill="none" strokeWidth="8" strokeLinecap="round" className="stroke-primary transition-all duration-700" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, value) / 100)} transform="rotate(-90 40 40)" />
      <text x="40" y="45" textAnchor="middle" className="fill-foreground text-[18px] font-bold">{value}</text>
    </svg>
  )
}

function Meter({ label, before, after }: { label: string; before: number; after: number }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="flex justify-between"><span className="font-medium">{label}</span><span className="text-muted-foreground">{before} now, {after} after publishing</span></div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary/40 transition-all duration-700" style={{ width: `${Math.min(100, after)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-700" style={{ width: `${Math.min(100, before)}%` }} />
      </div>
    </div>
  )
}

/** The link, the buttons and the plain text of it. Copy link, Text it, WhatsApp it, and the link itself to select by hand. */
function ShareControls({ url, sms, whatsapp, onRevoke, label }: { url: string; sms: string; whatsapp: string; onRevoke?: () => void; label: string }) {
  const { toast } = useToast()
  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: "Link copied" })
    } catch {
      toast({ title: "Could not copy", description: "Select the link below and copy it by hand.", variant: "destructive" })
    }
  }
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs font-semibold">{label}</p>
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-md border bg-background p-2 font-mono text-xs" aria-label="The link" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}><Copy className="mr-1 h-4 w-4" />Copy link</Button>
        <Button type="button" size="sm" variant="outline" asChild><a href={sms}><Send className="mr-1 h-4 w-4" />Text it</a></Button>
        <Button type="button" size="sm" variant="outline" asChild><a href={whatsapp} target="_blank" rel="noreferrer"><MessageCircle className="mr-1 h-4 w-4" />WhatsApp it</a></Button>
        {onRevoke && <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={onRevoke}>Revoke</Button>}
      </div>
      <p className="text-xs text-muted-foreground">If the apps do not open, select the link above and paste it into a message yourself. It works for 14 days and opens this one trip only.</p>
    </div>
  )
}

interface MadeLink { url: string; sms: string; whatsapp: string; shareId: string; kind: "agent" | "testimonial" }

export function RecapStudio({ packageId }: { packageId: string }) {
  const { toast } = useToast()
  const [v, setV] = useState<View | null>(null)
  const [error, setError] = useState("")
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState("")
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<"" | "saving" | "saved">("")
  const [order, setOrder] = useState<string[]>([])
  const [cover, setCover] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [agentName, setAgentName] = useState("")
  const [made, setMade] = useState<MadeLink[]>([])
  const [qText, setQText] = useState("")
  const [qFirst, setQFirst] = useState("")
  const [qLast, setQLast] = useState("")
  const [qConsent, setQConsent] = useState(false)
  const [edit, setEdit] = useState<{ summary: string; highlights: string; takeaways: string; faqs: { question: string; answer: string }[] } | null>(null)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [voiceFor, setVoiceFor] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)
  const voiceSupported = typeof window !== "undefined" && !!((window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/packages/${packageId}/recap-studio`, { headers: authHeaders(false) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Could not load (HTTP ${res.status})`)
      setV(body)
      if (!loaded.current) {
        loaded.current = true
        setAnswers(body.studio.answers ?? {})
        setOrder(body.photoOrder ?? [])
        setCover(body.studio.coverId ?? null)
      }
      setEdit(body.draft ? { summary: body.draft.draft.summary, highlights: body.draft.draft.highlights.join("\n"), takeaways: body.draft.draft.takeaways.join("\n"), faqs: body.draft.draft.faqs } : null)
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load")
    }
  }, [packageId])
  useEffect(() => { load() }, [load])

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`/api/admin/packages/${packageId}/recap-studio`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(out.error || `Failed (HTTP ${res.status})`), { errors: out.errors })
    return out
  }
  async function run(key: string, label: string, fn: () => Promise<void>, reload = true) {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      toast({ title: `${label} did not work`, description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
    } finally {
      setBusy("")
      if (reload) await load()
    }
  }

  // Autosave: every change to an answer, the photo order or the cover is saved a moment later.
  function queueSave(next: { answers?: Record<string, string>; photoOrder?: string[]; coverId?: string | null }) {
    setSaved("saving")
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const out = await post({ action: "save", ...next })
        setSaved("saved")
        if (out.errors?.length) toast({ title: "One answer was not kept", description: out.errors[0], variant: "destructive" })
      } catch (e) {
        setSaved("")
        toast({ title: "Could not save", description: e instanceof Error ? e.message : "Try again", variant: "destructive" })
      }
    }, 700)
  }
  const setAnswer = (id: string, value: string) => {
    const next = { ...answers, [id]: value }
    setAnswers(next)
    queueSave({ answers: next })
  }
  const setOrderSaved = (next: string[], coverId: string | null = cover) => {
    setOrder(next)
    queueSave({ photoOrder: next, coverId })
  }

  // Voice note: only when the browser has speech recognition. The words are added to the answer so you can fix them.
  function listen(id: string) {
    const W = window as unknown as Record<string, new () => { lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] & { length: number } }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void }>
    const Rec = W.SpeechRecognition || W.webkitSpeechRecognition
    if (!Rec) return
    const rec = new Rec()
    rec.lang = "en-CA"
    rec.interimResults = false
    setVoiceFor(id)
    rec.onresult = (e) => {
      const text = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(" ").trim()
      if (text) setAnswer(id, `${answers[id] ? `${answers[id]} ` : ""}${text}`)
    }
    rec.onend = () => setVoiceFor(null)
    rec.onerror = () => setVoiceFor(null)
    rec.start()
  }

  // ─── Photos ───────────────────────────────────────────────────────────────────────
  async function uploadPhoto(file: File): Promise<string> {
    if (file.size <= SERVER_UPLOAD_MAX) {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(false), body: form })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || `Upload failed (HTTP ${res.status})`)
      return out.id
    }
    const prepRes = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "upload-url" }) })
    const prep = await prepRes.json().catch(() => ({}))
    if (!prepRes.ok) throw new Error(prep.error || "Could not prepare the upload")
    const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type || undefined })
    if (up.error) throw new Error(up.error.message)
    const regRes = await fetch(`/api/admin/packages/${packageId}/recap/photos`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "register", path: prep.path, name: file.name }) })
    const reg = await regRes.json().catch(() => ({}))
    if (!regRes.ok) throw new Error(reg.error || "Could not add the photo")
    return reg.id
  }
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (!list.length) return
    await run("upload", "Adding photos", async () => {
      const ids: string[] = []
      const problems: string[] = []
      for (const f of list) {
        try { ids.push(await uploadPhoto(f)) } catch (e) { problems.push(`${f.name}: ${e instanceof Error ? e.message : "failed"}`) }
      }
      toast({ title: `Added ${ids.length} photo${ids.length === 1 ? "" : "s"}`, description: problems.length ? problems.slice(0, 3).join(" | ") : "Tap Pick the best 12 and I will choose for you.", variant: problems.length && !ids.length ? "destructive" : undefined })
    })
  }

  /** Measures each photo in the browser (size, shape, sharpness on a tiny grey copy) and keeps the best 12. */
  async function pickBest() {
    if (!v) return
    await run("pick", "Picking photos", async () => {
      const facts: PhotoFacts[] = []
      for (const p of v.photos) {
        let f: PhotoFacts = { id: p.id, bytes: 0, width: null, height: null, sharpness: null }
        if (p.preview_url) {
          try {
            const blob = await (await fetch(p.preview_url)).blob()
            const bmp = await createImageBitmap(blob)
            const c = document.createElement("canvas")
            c.width = 96
            c.height = Math.max(3, Math.round((96 * bmp.height) / bmp.width))
            const ctx = c.getContext("2d")
            let sharp: number | null = null
            if (ctx) {
              ctx.drawImage(bmp, 0, 0, c.width, c.height)
              const px = ctx.getImageData(0, 0, c.width, c.height).data
              const gray = new Float32Array(c.width * c.height)
              for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
              sharp = laplacianVariance(gray, c.width, c.height)
            }
            f = { id: p.id, bytes: blob.size, width: bmp.width, height: bmp.height, sharpness: sharp }
          } catch { /* keep the neutral facts */ }
        }
        facts.push(f)
      }
      const picked = pickBestPhotos(facts, GALLERY_PICK)
      setOrderSaved(picked.length ? picked : v.photos.slice(0, GALLERY_PICK).map((p) => p.id), cover && picked.includes(cover) ? cover : picked[0] ?? null)
      toast({ title: `Picked ${picked.length} photo${picked.length === 1 ? "" : "s"}`, description: "Change the order or the cover if you like." })
    }, false)
  }
  const toggleIn = (id: string) => setOrderSaved(order.includes(id) ? order.filter((x) => x !== id) : [...order, id].slice(0, GALLERY_PICK), order.includes(id) && cover === id ? null : cover)
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrderSaved(next)
  }
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId || !order.includes(dragId) || !order.includes(targetId)) return
    const next = order.filter((x) => x !== dragId)
    next.splice(next.indexOf(targetId), 0, dragId)
    setOrderSaved(next)
    setDragId(null)
  }
  async function takeOut(p: Photo) {
    await run(`take:${p.id}`, "Taking the photo out", async () => {
      const res = await fetch(`/api/admin/packages/${packageId}/sources/${p.id}/revert`, { method: "POST", headers: authHeaders() })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    })
  }

  // ─── Links, quotes, review ────────────────────────────────────────────────────────
  async function makeLink(kind: "agent" | "testimonial") {
    await run(`link:${kind}`, "Making the link", async () => {
      const out = await post({ action: "share-create", kind, agentName: kind === "agent" ? agentName : "" })
      setMade((m) => [{ url: out.url, sms: out.sms, whatsapp: out.whatsapp, shareId: out.shareId, kind }, ...m])
      toast({ title: "Link ready", description: "Copy it, text it or send it on WhatsApp." })
    })
  }
  async function revoke(shareId: string) {
    if (!confirm("Turn this link off? Anyone who has it will see that it no longer works.")) return
    await run("revoke", "Revoking", async () => {
      await post({ action: "share-revoke", shareId })
      setMade((m) => m.filter((x) => x.shareId !== shareId))
      toast({ title: "Link turned off" })
    })
  }
  async function addQuote() {
    await run("quote", "Adding the quote", async () => {
      await post({ action: "quote-add", text: qText, firstName: qFirst, lastName: qLast, consent: qConsent })
      setQText(""); setQFirst(""); setQLast(""); setQConsent(false)
      toast({ title: "Quote added", description: "It will show on the page after you publish." })
    })
  }
  async function decide(p: Pending, decision: "approve" | "reject") {
    await run(`decide:${p.id}`, decision === "approve" ? "Approving" : "Rejecting", async () => {
      const body: Record<string, unknown> = { action: "decide", submissionId: p.id, decision }
      if (decision === "approve" && p.kind === "quote" && editing[p.id] !== undefined) body.text = editing[p.id]
      if (decision === "approve" && p.kind === "answers" && editing[`${p.id}:a`] !== undefined) body.answers = JSON.parse(editing[`${p.id}:a`])
      await post(body)
      toast({ title: decision === "approve" ? "Approved" : "Rejected" })
    })
  }

  // ─── Draft and publish ────────────────────────────────────────────────────────────
  async function writeDraft() {
    await run("draft", "Writing the draft", async () => {
      const out = await post({ action: "draft" })
      toast({ title: out.blockers?.length ? "Draft written but held back" : "Draft ready", description: out.blockers?.length ? "The checks found things to fix. They are listed below." : "Read it next to your notes, then publish." })
    })
  }
  async function saveEdit() {
    if (!edit) return
    await run("edit", "Saving the edit", async () => {
      const out = await post({ action: "edit-draft", summary: edit.summary, highlights: edit.highlights, takeaways: edit.takeaways, faqs: edit.faqs })
      toast({ title: out.blockers?.length ? "Saved, but the checks still hold it" : "Saved. The checks pass." })
    })
  }
  async function publish() {
    await run("publish", "Publishing", async () => {
      const out = await post({ action: "publish" })
      toast({ title: "Your recap is live", description: `${out.photosAdded} photo${out.photosAdded === 1 ? "" : "s"} added. Search engines were told. You can undo it below.` })
      if (out.photoProblems?.length) toast({ title: "Some photos were not added", description: out.photoProblems.slice(0, 2).join(" | "), variant: "destructive" })
    })
  }
  async function undo() {
    if (!confirm("Take the recap off the page and put the page back the way it was?")) return
    await run("undo", "Undo", async () => {
      await post({ action: "undo" })
      toast({ title: "Recap taken off the page" })
    })
  }
  async function snooze() {
    await run("snooze", "Snoozing", async () => {
      await post({ action: "snooze" })
      toast({ title: "Snoozed for 7 days", description: "It will come back in your daily list next week." })
    }, false)
  }

  const photoMap = useMemo(() => new Map((v?.photos ?? []).map((p) => [p.id, p])), [v])
  const shown = useMemo(() => (v ? [...order.filter((id) => photoMap.has(id)), ...v.photos.map((p) => p.id).filter((id) => !order.includes(id))] : []), [v, order, photoMap])

  if (error) return <Card className="mx-auto max-w-3xl"><CardContent className="p-4 text-sm text-red-700 dark:text-red-400">{error}</CardContent></Card>
  if (!v) return <div className="flex items-center justify-center gap-2 p-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Warming up the Studio</div>

  const answered = QUESTIONS.filter((q) => (answers[q.id] ?? "").trim()).length
  const activeLinks = v.shares.filter((s) => s.state.ok && !made.some((m) => m.shareId === s.id))
  const draft = v.draft

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link href="/admin/packages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" />Back to trips</Link>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-4">
          <Ring value={v.score.after} />
          <div className="min-w-[220px] flex-1 space-y-1">
            <h1 className="text-xl font-bold">Recap Studio: {v.trip.name}</h1>
            <p className="text-sm text-muted-foreground">{v.trip.hasRecap ? "This trip already has a recap. Add more and publish again to improve it." : "Let us turn this trip into a page people find and trust. Five minutes is plenty."} The trip stays published the whole time.</p>
            <p className="text-xs text-muted-foreground">Recap score {v.score.now} now, {v.score.after} after what you have added. {saved === "saving" ? "Saving..." : saved === "saved" ? "Saved." : "Everything saves as you go."}</p>
          </div>
          <div className="w-full space-y-2 sm:w-64">
            <Meter label="Page score (thin page check)" before={v.thin.before} after={v.thin.after} />
            <Button type="button" size="sm" variant="ghost" onClick={snooze} disabled={busy === "snooze"}>Not today (snooze 7 days)</Button>
          </div>
          <ul className="grid w-full gap-1 sm:grid-cols-2">
            {v.score.items.map((it) => (
              <li key={it.id} className="flex items-center gap-2 text-sm">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border transition-all duration-500 ${it.done ? "scale-110 border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/40"}`}>{it.done && <Check className="h-3 w-3" />}</span>
                <span className={it.done ? "text-foreground" : "text-muted-foreground"}>{it.label}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* What came in through a link */}
      {v.pending.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardContent className="space-y-3 p-4">
            <h2 className="font-semibold">Waiting for you ({v.pending.length})</h2>
            <p className="text-xs text-muted-foreground">Nothing here is on the site. Approve, edit then approve, or reject each item.</p>
            {v.pending.map((p) => (
              <div key={p.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <p className="text-xs font-semibold uppercase text-muted-foreground">From {p.by || "someone"}: {p.kind === "answers" ? "answers" : p.kind === "quote" ? "a traveller quote (permission ticked)" : "a photo"}</p>
                {p.kind === "photo" && (
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.previewUrl ? <img src={p.previewUrl} alt={altTextFor(v.trip.name, v.trip.destination, 0)} className="h-20 w-28 rounded object-cover" /> : <div className="flex h-20 w-28 items-center justify-center rounded bg-muted text-xs">No preview</div>}
                    <p className="text-xs text-muted-foreground">{String(p.payload.name ?? "photo")}. {p.payload.metadataStripped ? "Location details removed." : "Location details could not be removed from this copy."}</p>
                  </div>
                )}
                {p.kind === "quote" && (
                  <>
                    <Textarea rows={2} value={editing[p.id] ?? String(p.payload.text ?? "")} onChange={(e) => setEditing({ ...editing, [p.id]: e.target.value })} />
                    <p className="text-xs text-muted-foreground">Shown as: {String(p.payload.name ?? "")}</p>
                  </>
                )}
                {p.kind === "answers" && (
                  <div className="space-y-2">
                    {QUESTIONS.filter((q) => ((p.payload.answers as Record<string, string> | undefined)?.[q.id] ?? "").trim()).map((q) => {
                      const cur = JSON.parse(editing[`${p.id}:a`] ?? JSON.stringify(p.payload.answers ?? {})) as Record<string, string>
                      return (
                        <label key={q.id} className="block space-y-1">
                          <span className="text-xs font-medium">{q.label}</span>
                          <Textarea rows={2} value={cur[q.id] ?? ""} onChange={(e) => setEditing({ ...editing, [`${p.id}:a`]: JSON.stringify({ ...cur, [q.id]: e.target.value }) })} />
                        </label>
                      )
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={busy === `decide:${p.id}`} onClick={() => decide(p, "approve")}><Check className="mr-1 h-4 w-4" />Approve</Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy === `decide:${p.id}`} onClick={() => decide(p, "reject")}><X className="mr-1 h-4 w-4" />Reject</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Steps */}
      <nav className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <button key={label} type="button" onClick={() => setStep(i)} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${step === i ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
            <span className="font-bold">{i + 1}</span>{label}
          </button>
        ))}
      </nav>

      {step === 0 && (
        <Card><CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">Step 1: Your photos</h2>
          <p className="text-sm text-muted-foreground">Drop in as many as you like. I will measure them and pick the best 12. Alt text is added for you using only the trip name and place, so nothing is claimed that the picture may not show.</p>
          <div onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }} className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm ${dragging ? "border-primary bg-primary/5" : "border-border"}`}>
            <Upload className="h-6 w-6 text-muted-foreground" />
            <p>Drag photos here, or choose them from your phone or computer.</p>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = "" }} />
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy === "upload"}>{busy === "upload" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Adding</> : "Choose photos"}</Button>
              <Button type="button" variant="outline" onClick={pickBest} disabled={busy === "pick" || v.photos.length === 0}>{busy === "pick" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Pick the best 12"}</Button>
            </div>
          </div>
          {shown.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {shown.map((id, idx) => {
                const p = photoMap.get(id)!
                const inRecap = order.includes(id)
                return (
                  <li key={id} draggable={inRecap} onDragStart={() => setDragId(id)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(id)} className={`space-y-1.5 rounded-lg border p-2 transition-opacity ${inRecap ? "" : "opacity-60"} ${dragId === id ? "opacity-40" : ""}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.preview_url ? <img src={p.preview_url} alt={altTextFor(v.trip.name, v.trip.destination, idx)} className="h-24 w-full rounded object-cover" /> : <div className="flex h-24 items-center justify-center rounded bg-muted text-xs">No preview</div>}
                    <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={inRecap} disabled={p.added} onChange={() => toggleIn(id)} />{p.added ? "On the page" : "Use in recap"}</label>
                    {inRecap && (
                      <div className="flex items-center justify-between">
                        <button type="button" aria-label="Make this the cover" title="Cover photo" onClick={() => { setCover(id); setOrderSaved([id, ...order.filter((x) => x !== id)], id) }}><Star className={`h-5 w-5 ${cover === id ? "fill-yellow-400 text-yellow-500" : "text-muted-foreground"}`} /></button>
                        <span className="flex gap-1">
                          <button type="button" aria-label="Move earlier" className="rounded border p-1" onClick={() => move(id, -1)}><ChevronLeft className="h-4 w-4" /></button>
                          <button type="button" aria-label="Move later" className="rounded border p-1" onClick={() => move(id, 1)}><ChevronRight className="h-4 w-4" /></button>
                        </span>
                      </div>
                    )}
                    {p.added && <Button type="button" size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={() => takeOut(p)}>Take out of the gallery</Button>}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{order.length} chosen (up to {GALLERY_PICK}). The cover is shown first. These are your own pictures, so they may go on the page.</p>
        </CardContent></Card>
      )}

      {step === 1 && (
        <Card><CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">Step 2: Five quick questions ({answered} of 5)</h2>
          <p className="text-sm text-muted-foreground">One or two sentences each, in your own words. The recap is written only from these and the trip page. Leave out phone numbers, emails and links.</p>
          {QUESTIONS.map((q) => (
            <div key={q.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`q-${q.id}`} className="text-sm font-medium">{q.label}</label>
                {voiceSupported && <Button type="button" size="sm" variant="ghost" onClick={() => listen(q.id)} disabled={voiceFor === q.id}><Mic className={`mr-1 h-4 w-4 ${voiceFor === q.id ? "animate-pulse text-red-600" : ""}`} />{voiceFor === q.id ? "Listening" : "Record a voice note"}</Button>}
              </div>
              <Textarea id={`q-${q.id}`} rows={2} maxLength={400} placeholder={q.hint} value={answers[q.id] ?? ""} onChange={(e) => setAnswer(q.id, e.target.value)} />
            </div>
          ))}
        </CardContent></Card>
      )}

      {step === 2 && (
        <Card><CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">Step 3: Traveller quotes</h2>
          <p className="text-sm text-muted-foreground">Only add words from someone who said it is fine to show them. First name and last initial only. A quote shows on the page only after you publish.</p>
          {v.quotes.length > 0 && <ul className="space-y-1 text-sm">{v.quotes.map((q) => <li key={`${q.name}:${q.text}`} className="flex gap-2 rounded border p-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span><span className="italic">{q.text}</span> <span className="text-muted-foreground">({q.name})</span></span></li>)}</ul>}
          <div className="space-y-2 rounded-lg border p-3">
            <Textarea rows={2} maxLength={400} placeholder="Their words" value={qText} onChange={(e) => setQText(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="First name" value={qFirst} maxLength={40} onChange={(e) => setQFirst(e.target.value)} />
              <Input placeholder="Last initial (optional)" value={qLast} maxLength={40} onChange={(e) => setQLast(e.target.value)} />
            </div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={qConsent} onChange={(e) => setQConsent(e.target.checked)} />I have this person's permission to show their words and first name on the website.</label>
            <Button type="button" size="sm" disabled={!qConsent || !qFirst.trim() || qText.trim().length < 12 || busy === "quote"} onClick={addQuote}>Add quote</Button>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Rather have the traveller write it?</p>
            <p className="text-xs text-muted-foreground">Make a link for them. They write a sentence and tick that you may show it. It waits here for your OK.</p>
            <Button type="button" size="sm" variant="outline" disabled={busy === "link:testimonial"} onClick={() => makeLink("testimonial")}>Send a testimonial request link</Button>
            {made.filter((m) => m.kind === "testimonial").map((m) => <ShareControls key={m.shareId} url={m.url} sms={m.sms} whatsapp={m.whatsapp} label="Testimonial request link" onRevoke={() => revoke(m.shareId)} />)}
          </div>
        </CardContent></Card>
      )}

      {step === 3 && (
        <Card><CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">Step 4: Preview and publish</h2>
          <p className="text-sm text-muted-foreground">One AI call writes a draft from your notes and the trip page. Checks look for invented facts, prices, names, superlatives and quotes nobody approved. A draft that fails stays private and says why.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={writeDraft} disabled={busy === "draft" || answered < 3}>{busy === "draft" ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Writing</> : draft ? "Write it again" : "Write the draft"}</Button>
            {answered < 3 && <p className="self-center text-xs text-amber-700 dark:text-amber-400">Answer at least 3 questions in step 2 first.</p>}
          </div>
          {draft && edit && (
            <>
              {draft.blockers.length > 0 ? (
                <div className="space-y-1 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100">
                  <p className="font-semibold">Held back. This draft is private until these are fixed:</p>
                  <ul className="list-disc pl-5">{draft.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
              ) : (
                <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">The checks pass. Read it once, then publish.</p>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">The draft (you can edit)</p>
                  <Textarea rows={8} value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} aria-label="Recap" />
                  <p className="text-xs text-muted-foreground">Highlights, one per line</p>
                  <Textarea rows={4} value={edit.highlights} onChange={(e) => setEdit({ ...edit, highlights: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Key takeaways, one per line</p>
                  <Textarea rows={3} value={edit.takeaways} onChange={(e) => setEdit({ ...edit, takeaways: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Questions and answers</p>
                  {edit.faqs.map((f, i) => (
                    <div key={i} className="space-y-1 rounded border p-2">
                      <Input value={f.question} onChange={(e) => setEdit({ ...edit, faqs: edit.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} aria-label={`Question ${i + 1}`} />
                      <Textarea rows={3} value={f.answer} onChange={(e) => setEdit({ ...edit, faqs: edit.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} aria-label={`Answer ${i + 1}`} />
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="outline" disabled={busy === "edit"} onClick={saveEdit}>Save my edits and check again</Button>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Where each sentence came from</p>
                  {v.trace && (
                    <ul className="space-y-1.5 text-xs">
                      {[...v.trace.summary, ...v.trace.highlights, ...v.trace.takeaways, ...v.trace.faqs.flatMap((f) => f.answer)].map((t, i) => (
                        <li key={i} className={`rounded border p-2 ${t.source ? "" : "border-amber-400 bg-amber-50 dark:bg-amber-950/30"}`}>
                          <span>{t.sentence}</span>
                          <span className="mt-1 block font-medium text-muted-foreground">{t.source ? `From: ${t.source}` : "No note or fact backs this. Edit it or take it out."}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">Search title: {draft.draft.metaTitle || "none"}. Search description: {draft.draft.metaDescription || "none"}.</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                <Button type="button" size="lg" className="h-14 flex-1 text-lg sm:flex-none sm:px-10" disabled={busy === "publish" || draft.blockers.length > 0} onClick={publish}>{busy === "publish" ? <Loader2 className="h-5 w-5 animate-spin" /> : "Publish the recap"}</Button>
                {v.trip.hasRecap && <Button type="button" variant="outline" disabled={busy === "undo"} onClick={undo}><Undo2 className="mr-1 h-4 w-4" />Undo</Button>}
                <a className="text-sm underline" href={`/packages/${v.trip.slug}`} target="_blank" rel="noreferrer">See the live page</a>
              </div>
            </>
          )}
          {!draft && v.trip.hasRecap && <Button type="button" variant="outline" disabled={busy === "undo"} onClick={undo}><Undo2 className="mr-1 h-4 w-4" />Undo the live recap</Button>}
        </CardContent></Card>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft className="mr-1 h-4 w-4" />Back</Button>
        <Button type="button" variant="ghost" disabled={step === 3} onClick={() => setStep(step + 1)}>Next<ArrowRight className="ml-1 h-4 w-4" /></Button>
      </div>

      {/* The agent link */}
      <Card><CardContent className="space-y-3 p-4">
        <h2 className="font-semibold">Ask a travel agent to fill this in</h2>
        <p className="text-sm text-muted-foreground">Make a private link for one trip. She opens it on her phone, adds photos, answers the five questions and can add quotes. No account, no password. What she sends waits here for your OK. The link works for 14 days.</p>
        {!v.migrated && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">One database update is missing: run migration 0053 (supabase/migrations/0053_recap_studio.sql) in the Supabase SQL editor to turn links on.</p>}
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-[220px]" placeholder="Her first name (optional)" value={agentName} maxLength={40} onChange={(e) => setAgentName(e.target.value)} aria-label="Agent first name" />
          <Button type="button" variant="outline" disabled={busy === "link:agent" || !v.migrated} onClick={() => makeLink("agent")}>Make a link</Button>
        </div>
        {made.filter((m) => m.kind === "agent").map((m) => <ShareControls key={m.shareId} url={m.url} sms={m.sms} whatsapp={m.whatsapp} label="Agent link (shown once, copy it now)" onRevoke={() => revoke(m.shareId)} />)}
        {activeLinks.length > 0 && (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {activeLinks.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span>{s.kind === "agent" ? "Agent link" : "Testimonial link"}{s.agent_name ? ` for ${s.agent_name}` : ""}, made {new Date(s.created_at).toLocaleDateString("en-CA")}, expires {new Date(s.expires_at).toLocaleDateString("en-CA")}, used {s.uses} time{s.uses === 1 ? "" : "s"}. The link itself is not kept, so make a new one if you lost it.</span>
                <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(s.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent></Card>
    </div>
  )
}
