"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Loader2, Activity, Pause, Play } from "lucide-react"

// The trip quiz funnel (lib/trip-quiz.ts QuizDayCounts), as /api/admin/trip-quiz sends it.
interface QuizFunnel {
  started: number
  q1: number
  q2: number
  q3: number
  q4: number
  result: number
  email: number
}
const QUIZ_FUNNEL_COLUMNS: { key: keyof QuizFunnel; label: string }[] = [
  { key: "started", label: "Started" },
  { key: "q1", label: "Answered Q1" },
  { key: "q2", label: "Answered Q2" },
  { key: "q3", label: "Answered Q3" },
  { key: "q4", label: "Answered Q4" },
  { key: "result", label: "Saw result" },
  { key: "email", label: "Gave email" },
]

interface CronStatus {
  name: string
  light: "green" | "amber" | "gray"
  label: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const LIGHT_VARIANT: Record<CronStatus["light"], "default" | "secondary" | "destructive"> = {
  green: "default",
  amber: "destructive",
  gray: "secondary",
}

const LIGHT_LABEL: Record<CronStatus["light"], string> = {
  green: "OK",
  amber: "Needs attention",
  gray: "Never run",
}

interface CrawlFinding {
  path: string
  kind: string
  severity: "error" | "warning" | "info"
  message: string
  hint: string
  firstSeen: string
}
interface CrawlCard {
  lastRun: string | null
  total: number
  checked7d: number
  errors: number
  warnings: number
  fixed: number
  budgetUsed: boolean
  note: string
  top: CrawlFinding[]
}

const SEVERITY_VARIANT: Record<CrawlFinding["severity"], "default" | "secondary" | "destructive"> = { error: "destructive", warning: "default", info: "secondary" }

export default function SystemHealthPage() {
  const [crawl, setCrawl] = useState<CrawlCard | null>(null)
  const [crawlError, setCrawlError] = useState("")
  const [crons, setCrons] = useState<CronStatus[]>([])
  const [paused, setPaused] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [visitsOn, setVisitsOn] = useState(false)
  const [visitsBusy, setVisitsBusy] = useState(false)
  const [ackOn, setAckOn] = useState(false)
  const [ackConfigured, setAckConfigured] = useState(false)
  const [ackBusy, setAckBusy] = useState(false)
  const [itOn, setItOn] = useState(false)
  const [itReady, setItReady] = useState(false)
  const [itTrips, setItTrips] = useState<{ slug: string; count: number }[]>([])
  const [itBusy, setItBusy] = useState(false)
  const [quizOn, setQuizOn] = useState(false)
  const [quizReady, setQuizReady] = useState(false)
  const [quizAckOn, setQuizAckOn] = useState(false)
  const [quizToday, setQuizToday] = useState<QuizFunnel | null>(null)
  const [quizWeek, setQuizWeek] = useState<QuizFunnel | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  function load() {
    setLoading(true)
    Promise.all([
      fetch("/api/admin/cron-health", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/automation-kill-switch", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/visit-tracking", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/lead-ack", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/itinerary-magnet", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
      fetch("/api/admin/trip-quiz", { headers: authHeaders() }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) })),
    ])
      .then(([cronRes, pauseRes, visitsRes, ackRes, itRes, quizRes]) => {
        if (quizRes.ok) {
          setQuizOn(!!quizRes.data.on)
          setQuizReady(!!quizRes.data.secretReady)
          setQuizAckOn(!!quizRes.data.ackOn)
          setQuizToday(quizRes.data.today ?? null)
          setQuizWeek(quizRes.data.week ?? null)
        }
        if (itRes.ok) {
          setItOn(!!itRes.data.on)
          setItReady(!!itRes.data.secretReady)
          setItTrips(Array.isArray(itRes.data.trips) ? itRes.data.trips : [])
        }
        if (ackRes.ok) {
          setAckOn(!!ackRes.data.on)
          setAckConfigured(!!ackRes.data.configured)
        }
        if (!cronRes.ok) throw new Error(cronRes.data.error || "Could not load")
        setCrons(cronRes.data.crons || [])
        if (pauseRes.ok) setPaused(!!pauseRes.data.paused)
        if (visitsRes.ok) setVisitsOn(!!visitsRes.data.on)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  // The site health crawl card is read only and loads on its own, so a problem reading it never hides the rest of the page.
  useEffect(() => {
    fetch("/api/admin/site-crawl", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then((res) => {
        if (res.ok) setCrawl(res.data as CrawlCard)
        else setCrawlError(res.data.error || "Could not load the site health crawl")
      })
      .catch(() => setCrawlError("Could not load the site health crawl"))
  }, [])

  async function toggleAutomation() {
    const next = !paused
    if (!next && !confirm("Resume automated publishing and posting? Autoblog and distribution will go back to whatever mode each was already set to.")) return
    setPauseBusy(true)
    try {
      const res = await fetch("/api/admin/automation-kill-switch", { method: "POST", headers: authHeaders(), body: JSON.stringify({ paused: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setPaused(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setPauseBusy(false)
    }
  }

  async function toggleVisits() {
    const next = !visitsOn
    if (next && !confirm("Turn visit counting on? Do this only after your lawyer has approved the cookie wording. Only people who click Accept on the cookie banner are counted.")) return
    setVisitsBusy(true)
    try {
      const res = await fetch("/api/admin/visit-tracking", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setVisitsOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setVisitsBusy(false)
    }
  }

  async function toggleAck() {
    const next = !ackOn
    if (next && !confirm("Turn on the instant lead reply? Every new real lead will get a short confirmation email. Do this only after the wording in lib/lead-ack-copy.ts has been approved for CASL.")) return
    setAckBusy(true)
    try {
      const res = await fetch("/api/admin/lead-ack", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setAckOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setAckBusy(false)
    }
  }

  async function toggleQuiz() {
    const next = !quizOn
    if (next && !confirm("Turn on the Find your trip in 60 seconds quiz? The quiz page and its cards go live on the site. The emails only go out if the instant lead reply is also on.")) return
    setQuizBusy(true)
    try {
      const res = await fetch("/api/admin/trip-quiz", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setQuizOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setQuizBusy(false)
    }
  }

  async function toggleItinerary() {
    const next = !itOn
    if (next && !confirm("Turn on Send me the itinerary and dates on trip pages? Migration 0062 must be applied first. The email part only goes out if the instant lead reply is also on.")) return
    setItBusy(true)
    try {
      const res = await fetch("/api/admin/itinerary-magnet", { method: "POST", headers: authHeaders(), body: JSON.stringify({ on: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Could not update")
      setItOn(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update")
    } finally {
      setItBusy(false)
    }
  }

  return (
    <div>
      <div className="border-b bg-card/30">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-bold">System Health</h1>
          <p className="text-sm text-muted-foreground">
            Whether each scheduled job is actually running. A cron shows "Never run" until <code>CRON_SECRET</code> is set and its schedule fires for the first time - that's expected while a phase is still dormant, not a bug.
          </p>
        </div>
      </div>

      <div className="container mx-auto space-y-3 px-4 py-4">
        {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        <Card className={paused ? "border-destructive" : undefined}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">{paused ? "Automation is paused" : "Automation is running normally"}</p>
              <p className="text-sm text-muted-foreground">
                One switch for both autoblog and social distribution. It overrides them without changing their individual settings — flip it back and each resumes whatever mode it already had.
              </p>
            </div>
            <Button variant={paused ? "default" : "destructive"} onClick={toggleAutomation} disabled={loading || pauseBusy}>
              {pauseBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : paused ? <Play className="mr-1.5 h-4 w-4" /> : <Pause className="mr-1.5 h-4 w-4" />}
              {paused ? "Resume automation" : "Pause all automation"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-[220px] flex-1">
              <p className="font-medium">{visitsOn ? "Visit counting is ON" : "Visit counting is OFF"}</p>
              <p className="text-sm text-muted-foreground">
                When on, this site counts visits itself, but only for people who click Accept on the cookie banner. It saves the page, the website they came from, the campaign tag, a random number and the time spent. It never saves an IP address. Turn this on only after your lawyer has approved the cookie wording. Records are deleted after 13 months.
              </p>
            </div>
            <Button variant={visitsOn ? "outline" : "default"} onClick={toggleVisits} disabled={loading || visitsBusy}>
              {visitsBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {visitsOn ? "Turn visit counting off" : "Turn visit counting on"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-[220px] flex-1">
              <p className="font-medium">{ackOn ? "Instant lead reply is ON" : "Instant lead reply is OFF"}</p>
              <p className="text-sm text-muted-foreground">
                When on, a new real lead gets one short "we got your message" email (at most one per address per 24 hours). It makes no promise about response time. The wording is a draft in <code>lib/lead-ack-copy.ts</code> and should be approved for CASL before this is turned on.
                {!ackConfigured && " Not ready yet: set RESEND_API_KEY and LEAD_ACK_FROM_EMAIL (an address on a domain verified in Resend), or nothing will be sent."}
              </p>
            </div>
            <Button variant={ackOn ? "outline" : "default"} onClick={toggleAck} disabled={loading || ackBusy}>
              {ackBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {ackOn ? "Turn instant reply off" : "Turn instant reply on"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-[220px] flex-1">
                <p className="font-medium">{itOn ? "Send me the itinerary and dates is ON" : "Send me the itinerary and dates is OFF"}</p>
                <p className="text-sm text-muted-foreground">
                  When on, upcoming trip pages offer a form (name, email, optional phone, unticked consent box). The visitor gets a private, printable itinerary built only from what is stored for the trip, and a link by email through the instant lead reply (so that switch, its daily limit and its sender settings decide whether the email goes). Each request is a lead marked as an itinerary request. Trip pages refresh every 5 minutes, so it can take that long to show or hide.
                  {!itReady && " Not ready yet: set ITINERARY_TOKEN_SECRET (or SESSION_SECRET), or the form will say it is not available."}
                </p>
              </div>
              <Button variant={itOn ? "outline" : "default"} onClick={toggleItinerary} disabled={loading || itBusy}>
                {itBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {itOn ? "Turn itinerary requests off" : "Turn itinerary requests on"}
              </Button>
            </div>
            {itTrips.length > 0 ? (
              <ul className="text-sm text-muted-foreground">
                {itTrips.map((t) => <li key={t.slug}><code>{t.slug}</code>: {t.count} request{t.count === 1 ? "" : "s"}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No itinerary requests yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-[220px] flex-1">
                <p className="font-medium">{quizOn ? "Find your trip in 60 seconds is ON" : "Find your trip in 60 seconds is OFF"}</p>
                <p className="text-sm text-muted-foreground">
                  When on, the page /trip-quiz asks four questions (who, trip style, when, how long) and shows up to three published trips picked by plain rules from the stored trip fields, with dates and with a price only where an agent confirmed one. A small card links to it from the home page, guide pages and blog posts. The last screen collects name, email and the unticked consent box, and the lead lands on the Lead desk as an itinerary request with the answers and matched trips in its message. The itinerary email goes through the instant lead reply (so that switch, its daily limit and its sender settings decide whether it goes); one follow-up email goes on day 3 to a lead who ticked the box and has not been contacted. Pages refresh every 5 minutes, so it can take that long to show or hide the cards.
                  {!quizReady && " Not ready yet: set ITINERARY_TOKEN_SECRET (or SESSION_SECRET), or the last screen will say it is not available."}
                  {!quizAckOn && " The instant lead reply is off, so no itinerary or follow-up emails will go out (the on-screen itinerary still works)."}
                </p>
              </div>
              <Button variant={quizOn ? "outline" : "default"} onClick={toggleQuiz} disabled={loading || quizBusy}>
                {quizBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {quizOn ? "Turn the trip quiz off" : "Turn the trip quiz on"}
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Funnel</th>
                    {QUIZ_FUNNEL_COLUMNS.map((c) => <th key={c.key} className="py-1 pr-3 font-medium">{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {([["Today (UTC)", quizToday], ["Last 7 days", quizWeek]] as const).map(([label, row]) => (
                    <tr key={label}>
                      <td className="py-1 pr-3">{label}</td>
                      {QUIZ_FUNNEL_COLUMNS.map((c) => <td key={c.key} className="py-1 pr-3">{row ? row[c.key] : 0}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">Counted on the server as screens are served (no cookies or scripts). A page refresh counts again, so treat the numbers as close, not exact.</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-[220px] flex-1">
                <p className="font-medium">Site health crawl</p>
                <p className="text-sm text-muted-foreground">
                  Once a day the site visits a rotating batch of its own pages the way Google does, so every page is checked about once a week. It looks at the page status, canonical address, search permission against the sitemap, title and description, headings, picture descriptions, structured data and links. Dead links in posts and guides are removed by themselves (the words stay) and can be undone on the Content edits page. Everything else is only listed here.
                </p>
              </div>
              {crawl && <Badge variant={crawl.errors > 0 ? "destructive" : "default"}>{crawl.errors > 0 ? `${crawl.errors} error${crawl.errors === 1 ? "" : "s"}` : "No errors"}</Badge>}
            </div>
            {crawlError && <p className="text-sm text-destructive">{crawlError}</p>}
            {crawl && !crawl.lastRun && <p className="text-sm text-muted-foreground">It has not run yet. It runs inside the daily Search Console snapshot, so the first result appears after that job fires once.</p>}
            {crawl && crawl.lastRun && (
              <>
                <p className="text-sm">
                  Pages checked in the last 7 days: <strong>{crawl.checked7d}</strong> of {crawl.total}. Errors: <strong>{crawl.errors}</strong>. Warnings: <strong>{crawl.warnings}</strong>. Fixed by itself in the last run: <strong>{crawl.fixed}</strong>.
                </p>
                <p className="text-xs text-muted-foreground">
                  Last run {new Date(crawl.lastRun).toLocaleString("en-CA", { timeZone: "America/Toronto" })}. {crawl.note}
                  {crawl.budgetUsed ? " (The time budget ran out before the whole batch was checked; the next run carries on where this one stopped.)" : ""}
                </p>
                {crawl.top.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing to fix in the pages checked so far.</p>
                ) : (
                  <ul className="space-y-2">
                    {crawl.top.slice(0, 12).map((f, i) => (
                      <li key={`${f.path}-${f.kind}-${i}`} className="rounded-md border p-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                          <a href={f.path} target="_blank" rel="noreferrer" className="font-mono text-xs underline">{f.path}</a>
                          <span className="text-xs text-muted-foreground">first seen {f.firstSeen.slice(0, 10)}</span>
                        </div>
                        <p className="mt-1">{f.message}</p>
                        <p className="text-xs text-muted-foreground">What to do: {f.hint}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : crons.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Activity className="h-8 w-8" />
            <p>No crons registered yet.</p>
          </div>
        ) : (
          crons.map((c) => (
            <Card key={c.name}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-[220px] flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.label}</p>
                </div>
                <Badge variant={LIGHT_VARIANT[c.light]}>{LIGHT_LABEL[c.light]}</Badge>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
