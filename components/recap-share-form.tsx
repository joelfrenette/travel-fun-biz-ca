"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/integrations/supabase/client"
import { CheckCircle2, Loader2, Upload } from "lucide-react"
import { ANSWER_MAX, PHOTO_MAX_BYTES, PHOTOS_MAX, QUOTE_MAX } from "@/lib/recap-studio"

// The public recap page behind /recap/<token> (Recap Studio). No account, no password: the link is the key, it opens ONE trip, and
// everything sent here waits for the owner's OK before it is shown anywhere. An "agent" link takes photos, five short answers and
// optional quotes; a "testimonial" link takes one short quote from a traveller.

interface Info {
  kind: "agent" | "testimonial"
  tripName: string
  when: string | null
  destination: string
  agentName: string | null
  expiresAt: string
  questions: { id: string; label: string; hint: string }[]
  photosSent: number
}

const BUCKET = "package-sources"
const HONEYPOT = "company_website"

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, [HONEYPOT]: (document.getElementById("recap-hp") as HTMLInputElement | null)?.value ?? "" }) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || `Something went wrong (${res.status}). Please try again.`)
  return out
}

export function RecapShareForm({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState("")
  const [yourName, setYourName] = useState("")
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [photosSent, setPhotosSent] = useState(0)
  const [uploading, setUploading] = useState("")
  const [photoNotes, setPhotoNotes] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [answersSent, setAnswersSent] = useState(false)
  const [busy, setBusy] = useState("")
  const [msg, setMsg] = useState("")
  const [quoteText, setQuoteText] = useState("")
  const [first, setFirst] = useState("")
  const [last, setLast] = useState("")
  const [consent, setConsent] = useState(false)
  const [quotesSent, setQuotesSent] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`/api/recap/${encodeURIComponent(token)}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "This link is not valid.")
        setInfo(body)
        setPhotosSent(body.photosSent ?? 0)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "This link is not valid."))
  }, [token])

  async function sendPhotos(files: FileList | File[]) {
    if (!info) return
    const list = Array.from(files)
    const notes: string[] = []
    for (const f of list) {
      if (photosSent + 1 > PHOTOS_MAX) {
        notes.push(`You can send up to ${PHOTOS_MAX} photos in all.`)
        break
      }
      if (f.size > PHOTO_MAX_BYTES) {
        notes.push(`${f.name}: over 12 MB, please send a smaller copy.`)
        continue
      }
      setUploading(f.name)
      try {
        const prep = await postJson(`/api/recap/${encodeURIComponent(token)}/photos`, { action: "upload-url", name: f.name, size: f.size })
        const up = await supabase.storage.from(BUCKET).uploadToSignedUrl(prep.path, prep.token, f, { contentType: f.type || undefined })
        if (up.error) throw new Error("The upload did not finish. Please try that photo again.")
        await postJson(`/api/recap/${encodeURIComponent(token)}/photos`, { action: "register", path: prep.path, name: f.name })
        setPhotosSent((n) => n + 1)
      } catch (e) {
        notes.push(`${f.name}: ${e instanceof Error ? e.message : "failed"}`)
      }
    }
    setUploading("")
    setPhotoNotes(notes)
  }

  async function sendAnswers() {
    setBusy("answers")
    setMsg("")
    try {
      await postJson(`/api/recap/${encodeURIComponent(token)}`, { action: "answers", answers, yourName })
      setAnswersSent(true)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not send. Please try again.")
    } finally {
      setBusy("")
    }
  }

  async function sendQuote() {
    setBusy("quote")
    setMsg("")
    try {
      await postJson(`/api/recap/${encodeURIComponent(token)}`, { action: "quote", text: quoteText, firstName: first, lastName: last, consent, yourName })
      setQuotesSent((n) => n + 1)
      setQuoteText("")
      setFirst("")
      setLast("")
      setConsent(false)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not send. Please try again.")
    } finally {
      setBusy("")
    }
  }

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto min-h-screen max-w-xl px-4 py-8 text-base">
      {children}
      {/* Honeypot: people never see it; a bot that fills every field fills this one and is quietly ignored. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label>Website<input id="recap-hp" name="company_website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
      </div>
      <p className="mt-10 text-center text-xs text-muted-foreground">TravelFunBiz.ca. This page is private to you. Nothing you send is shown on the website until the owner has read it and said yes.</p>
    </main>
  )

  if (error) return shell(<div className="rounded-lg border bg-card p-6 text-center"><h1 className="mb-2 text-xl font-bold">This link cannot be used</h1><p className="text-muted-foreground">{error}</p></div>)
  if (!info) return shell(<div className="flex items-center justify-center gap-2 p-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />Loading</div>)

  const isAgent = info.kind === "agent"
  const filled = Object.values(answers).filter((v) => v.trim()).length
  const hello = info.agentName ? `Hi ${info.agentName}!` : "Hi there!"

  return shell(
    <div className="space-y-8">
      <header className="space-y-2 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">{isAgent ? "Share your trip memories" : "Tell us how it went"}</p>
        <h1 className="text-balance text-2xl font-bold">{info.tripName}</h1>
        <p className="text-sm text-muted-foreground">{[info.when, info.destination].filter(Boolean).join(" | ")}</p>
        <p className="text-pretty text-muted-foreground">
          {hello} {isAgent ? "Thank you for helping. It takes about 5 minutes and works fine on your phone. Add what you like, skip what you do not. Please only share what really happened, in your own words." : "A sentence or two about your time on this trip would mean a lot. It takes about a minute."}
        </p>
      </header>

      {isAgent && (
        <>
          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h2 className="font-semibold">1. Your first name</h2>
            <Input value={yourName} maxLength={40} placeholder="First name" onChange={(e) => setYourName(e.target.value)} className="h-12 text-base" aria-label="Your first name" />
          </section>

          <section className="space-y-3 rounded-lg border bg-card p-4">
            <h2 className="font-semibold">2. Photos {photosSent > 0 && <span className="text-sm font-normal text-emerald-700">({photosSent} sent)</span>}</h2>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); sendPhotos(e.dataTransfer.files) }}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-5 text-center text-sm ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <Upload className="h-6 w-6 text-muted-foreground" />
              <p>JPG, PNG, WebP or HEIC. Up to {PHOTOS_MAX} photos, 12 MB each.</p>
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden onChange={(e) => { if (e.target.files) sendPhotos(e.target.files); e.target.value = "" }} />
              <Button type="button" className="h-12 px-6 text-base" disabled={!!uploading || photosSent >= PHOTOS_MAX} onClick={() => fileInput.current?.click()}>
                {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending</> : "Choose photos"}
              </Button>
              {uploading && <p className="text-xs text-muted-foreground">Sending {uploading}</p>}
              <p className="text-xs text-muted-foreground">Location details are removed from the copies we keep.</p>
            </div>
            {photoNotes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">{photoNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </section>

          <section className="space-y-4 rounded-lg border bg-card p-4">
            <h2 className="font-semibold">3. Five quick questions</h2>
            <p className="text-sm text-muted-foreground">One or two sentences each. Please leave out phone numbers, emails and web links.</p>
            {info.questions.map((q) => (
              <label key={q.id} className="block space-y-1">
                <span className="text-sm font-medium">{q.label}</span>
                <Textarea rows={2} maxLength={ANSWER_MAX} value={answers[q.id] ?? ""} placeholder={q.hint} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} className="text-base" disabled={answersSent} />
              </label>
            ))}
            {answersSent ? (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />Sent. Thank you!</p>
            ) : (
              <Button type="button" className="h-12 w-full text-base" disabled={busy === "answers" || filled === 0} onClick={sendAnswers}>{busy === "answers" ? <Loader2 className="h-4 w-4 animate-spin" /> : `Send my answers${filled ? ` (${filled})` : ""}`}</Button>
            )}
          </section>
        </>
      )}

      <section className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="font-semibold">{isAgent ? "4. A traveller quote (optional)" : "Your words"}</h2>
        {isAgent && <p className="text-sm text-muted-foreground">Only add words from someone who said it is fine for us to show them. Do not write a quote for anyone.</p>}
        <Textarea rows={3} maxLength={QUOTE_MAX} value={quoteText} placeholder={isAgent ? "What they said, in their words" : "A sentence or two about the trip"} onChange={(e) => setQuoteText(e.target.value)} className="text-base" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={first} maxLength={40} placeholder={isAgent ? "Their first name" : "Your first name"} onChange={(e) => setFirst(e.target.value)} className="h-12 text-base" aria-label="First name" />
          <Input value={last} maxLength={40} placeholder="Last initial (optional)" onChange={(e) => setLast(e.target.value)} className="h-12 text-base" aria-label="Last name or initial" />
        </div>
        <p className="text-xs text-muted-foreground">Only the first name and one letter of the last name are shown, like "Sam T."</p>
        <label className="flex items-start gap-3 rounded-md bg-muted/50 p-3 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 h-5 w-5" />
          <span>{isAgent ? "I have this person's permission for TravelFunBiz.ca to show their first name, last initial and these words on the website." : "TravelFunBiz.ca may show my first name, last initial and these words on its website."}</span>
        </label>
        <Button type="button" className="h-12 w-full text-base" disabled={busy === "quote" || !consent || quoteText.trim().length < 12 || !first.trim()} onClick={sendQuote}>{busy === "quote" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send this quote"}</Button>
        {quotesSent > 0 && <p className="flex items-center gap-2 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />Sent {quotesSent}. Thank you!</p>}
      </section>

      {msg && <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">{msg}</p>}
      <p className="text-center text-xs text-muted-foreground">This link works until {new Date(info.expiresAt).toLocaleDateString("en-CA", { dateStyle: "long" })}. Please do not share it.</p>
    </div>,
  )
}
