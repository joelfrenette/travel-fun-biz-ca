"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ChevronDown, ChevronRight, Loader2, Mic, MicOff, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { PLAN_START, PLAN_WEEKS, type Roadmap, type RoadmapEpic, type RoadmapUseCase, type UseCaseStatus } from "@/types/roadmap"

const STATUSES: UseCaseStatus[] = ["backlog", "in_progress", "done"]
const STATUS_LABEL: Record<UseCaseStatus, string> = { backlog: "Backlog", in_progress: "In progress", done: "Done" }
const STATUS_CLASS: Record<UseCaseStatus, string> = {
  backlog: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-500 text-white",
  done: "bg-emerald-600 text-white",
}
const UNSORTED = "__unsorted__"

type View = "roadmap" | "epics" | "board"

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function statusOf(list: RoadmapUseCase[]): UseCaseStatus {
  if (list.length === 0) return "backlog"
  if (list.every((u) => u.status === "done")) return "done"
  if (list.some((u) => u.status !== "backlog")) return "in_progress"
  return "backlog"
}

// ─── Roadmap (Gantt) ────────────────────────────────────────────────
function Gantt({ epics, usecases }: { epics: RoadmapEpic[]; usecases: RoadmapUseCase[] }) {
  const labelW = 220, weekW = 46, rowH = 40, headH = 46
  const width = labelW + PLAN_WEEKS * weekW + 16
  const height = headH + Math.max(epics.length, 1) * rowH + 12
  const start = new Date(`${PLAN_START}T00:00:00`)
  const todayWeeks = (Date.now() - start.getTime()) / (7 * 864e5)
  const todayX = labelW + todayWeeks * weekW

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block" role="img" aria-label="Roadmap by week">
        {Array.from({ length: PLAN_WEEKS }, (_, w) => {
          const x = labelW + w * weekW
          const d = new Date(start.getTime() + w * 7 * 864e5)
          return (
            <g key={w}>
              <line x1={x} y1={headH - 8} x2={x} y2={height} className="stroke-border" />
              <text x={x + weekW / 2} y={18} textAnchor="middle" className="fill-muted-foreground text-[11px]">W{w + 1}</text>
              <text x={x + weekW / 2} y={32} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                {d.toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
              </text>
            </g>
          )
        })}
        {epics.map((e, i) => {
          const y = headH + i * rowH
          const list = usecases.filter((u) => u.epic_id === e.id)
          const done = list.filter((u) => u.status === "done").length
          const ratio = list.length ? done / list.length : 0
          const s = Math.max(1, e.start_week), len = Math.max(1, e.end_week - s + 1)
          const bx = labelW + (s - 1) * weekW + 3, bw = len * weekW - 6, by = y + 10, bh = rowH - 20
          const st = statusOf(list)
          return (
            <g key={e.id}>
              <line x1={0} y1={y + rowH} x2={width} y2={y + rowH} className="stroke-border" />
              <text x={12} y={y + 18} className="fill-foreground text-[13px] font-semibold">{e.code} {e.title}</text>
              <text x={12} y={y + 32} className="fill-muted-foreground text-[11px]">{done}/{list.length} use cases done</text>
              <rect x={bx} y={by} width={bw} height={bh} rx={4} className={cn("stroke-border", st === "backlog" ? "fill-muted" : "fill-secondary")} />
              {ratio > 0 && <rect x={bx} y={by} width={Math.max(4, bw * ratio)} height={bh} rx={4} className="fill-emerald-600" />}
              {st === "in_progress" && ratio < 1 && (
                <rect x={bx + bw * ratio} y={by + bh - 5} width={bw * (1 - ratio)} height={5} rx={2} className="fill-amber-500" />
              )}
            </g>
          )
        })}
        {todayWeeks >= 0 && todayWeeks <= PLAN_WEEKS && (
          <g>
            <line x1={todayX} y1={headH - 8} x2={todayX} y2={height} className="stroke-primary" strokeWidth={2} strokeDasharray="4 3" />
            <text x={todayX + 4} y={headH - 12} className="fill-primary text-[11px] font-semibold">today</text>
          </g>
        )}
      </svg>
    </div>
  )
}

// ─── Use case row ───────────────────────────────────────────────────
function StatusChips({ usecase, onChange, busy }: { usecase: RoadmapUseCase; onChange: (id: string, status: UseCaseStatus) => void; busy: boolean }) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          disabled={busy || usecase.status === s}
          onClick={() => onChange(usecase.id, s)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-default",
            usecase.status === s ? cn("border-transparent", STATUS_CLASS[s]) : "bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

function UseCaseRow({ usecase, onChange, busy }: { usecase: RoadmapUseCase; onChange: (id: string, status: UseCaseStatus) => void; busy: boolean }) {
  return (
    <li className="grid gap-2 rounded-md bg-muted/50 px-3 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="text-sm">{usecase.title}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold">{usecase.priority}</span>
          {usecase.source === "admin" && <span> · added from the admin</span>}
          {usecase.note && <span> · {usecase.note}</span>}
        </p>
      </div>
      <StatusChips usecase={usecase} onChange={onChange} busy={busy} />
    </li>
  )
}

// ─── Add use case dialog (typed or dictated) ────────────────────────
type SpeechRecognitionCtor = new () => {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null
  start: () => void; stop: () => void
}

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function AddUseCaseDialog({ open, onClose, roadmap, onCreated }: { open: boolean; onClose: () => void; roadmap: Roadmap; onCreated: (u: RoadmapUseCase) => void }) {
  const [title, setTitle] = useState("")
  const [epicId, setEpicId] = useState<string>(UNSORTED)
  const [featureId, setFeatureId] = useState<string>("")
  const [priority, setPriority] = useState("P2")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [listening, setListening] = useState(false)
  const recognizer = useRef<InstanceType<SpeechRecognitionCtor> | null>(null)
  const speechSupported = typeof window !== "undefined" && !!getSpeechRecognition()
  const features = roadmap.features.filter((f) => f.epic_id === epicId)

  useEffect(() => { if (!open) stopListening() }, [open])

  function startListening() {
    const Ctor = getSpeechRecognition()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = "en-CA"
    rec.continuous = true
    rec.interimResults = true
    let finalText = title ? title + " " : ""
    rec.onresult = (e) => {
      let interim = ""
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += chunk + " "
        else interim += chunk
      }
      setTitle((finalText + interim).trim())
    }
    rec.onerror = (e) => { setError(e.error === "not-allowed" ? "Microphone access was blocked. Type the idea instead." : `Dictation stopped: ${e.error}`); setListening(false) }
    rec.onend = () => setListening(false)
    recognizer.current = rec
    setError("")
    setListening(true)
    rec.start()
  }

  function stopListening() {
    recognizer.current?.stop()
    recognizer.current = null
    setListening(false)
  }

  async function submit() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/admin/roadmap", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title, epic_id: epicId === UNSORTED ? null : epicId, feature_id: featureId || null, priority }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      onCreated(data.usecase)
      setTitle(""); setEpicId(UNSORTED); setFeatureId(""); setPriority("P2")
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a use case</DialogTitle>
          <DialogDescription>
            Say it or type it. Leave it Unsorted and Claude will file it under the right epic on the next Claude Code review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="uc-title">Idea</Label>
              {speechSupported && (
                <Button type="button" size="sm" variant={listening ? "destructive" : "outline"} onClick={listening ? stopListening : startListening}>
                  {listening ? <><MicOff className="mr-1 h-4 w-4" />Stop</> : <><Mic className="mr-1 h-4 w-4" />Dictate</>}
                </Button>
              )}
            </div>
            <Textarea id="uc-title" rows={4} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="As the admin, I want … so that …" />
            {listening && <p className="text-xs text-muted-foreground">Listening… speak naturally, then press Stop.</p>}
            {!speechSupported && <p className="text-xs text-muted-foreground">Dictation needs Chrome or Edge; typing works everywhere.</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Epic</Label>
              <Select value={epicId} onValueChange={(v) => { setEpicId(v); setFeatureId("") }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSORTED}>Unsorted (let Claude file it)</SelectItem>
                  {roadmap.epics.map((e) => <SelectItem key={e.id} value={e.id}>{e.code} {e.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="P1">P1 · must have</SelectItem>
                  <SelectItem value="P2">P2 · should have</SelectItem>
                  <SelectItem value="P3">P3 · nice to have</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {features.length > 0 && (
            <div className="space-y-2">
              <Label>Feature (optional)</Label>
              <Select value={featureId} onValueChange={setFeatureId}>
                <SelectTrigger><SelectValue placeholder="Pick a feature" /></SelectTrigger>
                <SelectContent>
                  {features.map((f) => <SelectItem key={f.id} value={f.id}>{f.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={saving || title.trim().length < 3}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}Add to backlog
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ───────────────────────────────────────────────────────────
export default function TrackerPage() {
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null)
  const [error, setError] = useState("")
  const [view, setView] = useState<View>("roadmap")
  const [openEpics, setOpenEpics] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)

  useEffect(() => {
    fetch("/api/admin/roadmap", { headers: authHeaders() })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        setRoadmap(data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the roadmap"))
  }, [])

  const counts = useMemo(() => {
    const c = { backlog: 0, in_progress: 0, done: 0 }
    roadmap?.usecases.forEach((u) => { c[u.status]++ })
    return c
  }, [roadmap])

  async function changeStatus(id: string, status: UseCaseStatus) {
    if (!roadmap) return
    const previous = roadmap.usecases.find((u) => u.id === id)?.status
    setBusy((b) => ({ ...b, [id]: true }))
    setRoadmap({ ...roadmap, usecases: roadmap.usecases.map((u) => (u.id === id ? { ...u, status } : u)) })
    try {
      const res = await fetch(`/api/admin/roadmap/${id}`, { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ status }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    } catch (e) {
      setRoadmap((r) => r && { ...r, usecases: r.usecases.map((u) => (u.id === id && previous ? { ...u, status: previous } : u)) })
      alert(e instanceof Error ? e.message : "Could not save the change")
    } finally {
      setBusy((b) => ({ ...b, [id]: false }))
    }
  }

  if (error) return <div className="p-6 text-destructive">{error}</div>
  if (!roadmap) return <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const unsorted = roadmap.usecases.filter((u) => !u.epic_id)

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">Project Tracker</h1>
            <p className="text-sm text-muted-foreground">
              {roadmap.epics.length} epics · {counts.in_progress} in progress · {counts.backlog} backlog · {counts.done} done
              {unsorted.length > 0 && <> · <span className="font-medium text-primary">{unsorted.length} waiting for triage</span></>}
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)}><Plus className="mr-1 h-4 w-4" />Add use case</Button>
        </div>
      </div>

      <div className="container mx-auto px-4 py-4">
        <div className="mb-4 flex gap-1">
          {(["roadmap", "epics", "board"] as View[]).map((v) => (
            <Button key={v} variant={view === v ? "secondary" : "ghost"} size="sm" onClick={() => setView(v)} className="capitalize">{v}</Button>
          ))}
        </div>

        {view === "roadmap" && (
          <div className="space-y-3">
            <Gantt epics={roadmap.epics} usecases={roadmap.usecases} />
            <p className="text-xs text-muted-foreground">Green fills with the share of an epic's use cases that are done; amber marks an epic in progress; the dashed line is today. Plan starts the week of {PLAN_START}.</p>
          </div>
        )}

        {view === "epics" && (
          <div className="space-y-3">
            {unsorted.length > 0 && (
              <Card className="border-primary/40">
                <CardContent className="p-4">
                  <h2 className="font-semibold">Waiting for triage</h2>
                  <p className="mb-3 text-sm text-muted-foreground">Ideas added from the admin that Claude has not filed under an epic yet.</p>
                  <ul className="space-y-2">{unsorted.map((u) => <UseCaseRow key={u.id} usecase={u} onChange={changeStatus} busy={!!busy[u.id]} />)}</ul>
                </CardContent>
              </Card>
            )}
            {roadmap.epics.map((e) => {
              const all = roadmap.usecases.filter((u) => u.epic_id === e.id)
              const done = all.filter((u) => u.status === "done").length
              const pct = all.length ? Math.round((100 * done) / all.length) : 0
              const feats = roadmap.features.filter((f) => f.epic_id === e.id)
              const isOpen = openEpics[e.id] ?? statusOf(all) === "in_progress"
              return (
                <Card key={e.id}>
                  <button type="button" className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpenEpics((o) => ({ ...o, [e.id]: !isOpen }))} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="text-lg font-bold text-primary">{e.code}</span>
                    <div className="min-w-0 flex-1">
                      <h2 className="font-semibold">{e.title}</h2>
                      <p className="text-xs text-muted-foreground">Weeks {e.start_week}–{e.end_week} · {feats.length} features · {done}/{all.length} done · {STATUS_LABEL[statusOf(all)]}</p>
                    </div>
                    <div className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block" title={`${pct}% done`}><div className="h-full bg-emerald-600" style={{ width: `${pct}%` }} /></div>
                  </button>
                  {isOpen && (
                    <CardContent className="border-t pt-4">
                      <p className="mb-3 max-w-prose text-sm text-muted-foreground">{e.goal}</p>
                      {feats.map((f) => {
                        const list = all.filter((u) => u.feature_id === f.id)
                        return (
                          <div key={f.id} className="border-t py-3">
                            <div className="flex items-center gap-2">
                              <span className={cn("h-2.5 w-2.5 rounded-full", statusOf(list) === "done" ? "bg-emerald-600" : statusOf(list) === "in_progress" ? "bg-amber-500" : "bg-muted-foreground/50")} />
                              <h3 className="font-medium">{f.title}</h3>
                            </div>
                            {f.note && <p className="ml-5 text-xs text-muted-foreground">{f.note}</p>}
                            <ul className="mt-2 space-y-1.5">{list.map((u) => <UseCaseRow key={u.id} usecase={u} onChange={changeStatus} busy={!!busy[u.id]} />)}</ul>
                          </div>
                        )
                      })}
                      {all.filter((u) => !u.feature_id).length > 0 && (
                        <div className="border-t py-3">
                          <h3 className="font-medium">Not assigned to a feature</h3>
                          <ul className="mt-2 space-y-1.5">{all.filter((u) => !u.feature_id).map((u) => <UseCaseRow key={u.id} usecase={u} onChange={changeStatus} busy={!!busy[u.id]} />)}</ul>
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        )}

        {view === "board" && (
          <div className="grid gap-3 md:grid-cols-3">
            {STATUSES.map((s) => {
              const list = roadmap.usecases.filter((u) => u.status === s)
              return (
                <Card key={s}>
                  <CardContent className="p-3">
                    <div className="flex items-baseline justify-between px-1 pb-2"><h2 className="font-semibold">{STATUS_LABEL[s]}</h2><span className="text-lg font-bold">{list.length}</span></div>
                    <div className="space-y-2">
                      {list.map((u) => {
                        const e = roadmap.epics.find((x) => x.id === u.epic_id)
                        return (
                          <div key={u.id} className="space-y-1.5 rounded-md bg-muted/50 p-3">
                            <div className="flex items-center justify-between gap-2"><Badge variant="outline" className="text-[10px]">{e ? `${e.code} · ${e.title}` : "Unsorted"}</Badge><span className="text-xs font-semibold text-muted-foreground">{u.priority}</span></div>
                            <p className="text-sm">{u.title}</p>
                            <StatusChips usecase={u} onChange={changeStatus} busy={!!busy[u.id]} />
                          </div>
                        )
                      })}
                      {list.length === 0 && <p className="px-1 text-sm text-muted-foreground">Nothing here.</p>}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <AddUseCaseDialog open={addOpen} onClose={() => setAddOpen(false)} roadmap={roadmap} onCreated={(u) => setRoadmap((r) => r && { ...r, usecases: [u, ...r.usecases] })} />
    </div>
  )
}
