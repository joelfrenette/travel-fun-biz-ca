"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { MiningState } from "@/lib/gsc-mining"
import type { CannibalState } from "@/lib/cannibalization"
import type { HubSpokeState } from "@/lib/hub-spoke"
import type { StoredCompetitor } from "@/lib/competitor-scan"
import type { AutoDecision } from "@/lib/auto-decisions"

interface Payload {
  mining: MiningState
  cannibal: CannibalState
  hubspoke: HubSpokeState
  competitors: {
    list: string[]
    state: Record<string, StoredCompetitor>
    max: number
    tasks: { id: string; title: string; how: string; steps: string[] }[]
    manualSteps: { businessProfile: string[]; backlinks: string[] }
    cannotRead: string
  }
  decisions: AutoDecision[]
  switches: { policy: string; label: string; cap: number; on: boolean; readable: boolean }[]
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, "")
  } catch {
    return origin
  }
}

const TYPE_WORDS: Record<string, string> = { blog: "blog post", guide: "guide page", "from-city": "from-your-city page", compare: "compare page", "best-time": "best-time page" }

/** The four SEO engine cards: searches we should build pages for, pages competing with each other, competitors, hub and spoke map. */
export function SeoEnginesPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [note, setNote] = useState("")
  const [url, setUrl] = useState("")

  const load = useCallback(() => {
    fetch("/api/admin/seo-engines", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "could not be read")
        setData(body)
        setError("")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "could not be read"))
  }, [])
  useEffect(load, [load])

  async function call(path: string, body: Record<string, unknown>, key: string) {
    setBusy(key)
    setNote("")
    try {
      const r = await fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      const j = await r.json().catch(() => ({}))
      setNote(j.message || j.error || j.note || (r.ok ? "Done." : "That did not work."))
      if (r.ok) load()
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not work.")
    } finally {
      setBusy("")
    }
  }

  async function scanAll(list: string[]) {
    setBusy("scan")
    setNote("")
    try {
      for (const origin of list) {
        setNote(`Scanning ${hostOf(origin)} (up to a minute) ...`)
        const r = await fetch("/api/admin/seo-engines/scan", { method: "POST", headers: authHeaders(), body: JSON.stringify({ url: origin }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) {
          setNote(j.error || "The scan did not work.")
          break
        }
        setNote(j.note || "Done.")
      }
      load()
    } finally {
      setBusy("")
    }
  }

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">The SEO engines could not be read: {error}</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading ...</p>
  const { mining, cannibal, hubspoke, competitors, decisions, switches } = data
  const undoable = (d: AutoDecision) => !!d.undo && !d.undone_at

  return (
    <div className="space-y-4">
      {note && <p className="rounded border bg-muted/40 px-3 py-2 text-sm" role="status">{note}</p>}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-base font-semibold">Searches we should build pages for</h2>
          <p className="text-sm text-muted-foreground">
            Searches Google already shows us for where none of our pages is a good match, grouped by topic, closest to page one first.
            {mining.at ? ` Last mined ${when(mining.at)} (${mining.source === "live" ? "live Search Console data" : mining.source === "stored" ? "saved daily snapshot" : "no data"}).` : " Not mined yet: it runs once a day."}
          </p>
          {mining.note && <p className="text-xs text-muted-foreground">{mining.note}</p>}
          {mining.proposals.length === 0 ? (
            <p className="text-sm">Nothing to build right now.</p>
          ) : (
            <ul className="space-y-3">
              {mining.proposals.map((p) => (
                <li key={p.id} className="rounded border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.primary}</span>
                      {p.striking && <Badge>Close to page one</Badge>}
                      <Badge variant="outline">Best as {TYPE_WORDS[p.pageType] ?? p.pageType}</Badge>
                    </div>
                    {p.pageType === "blog" ? (
                      <Button size="sm" variant="outline" disabled={busy === `t-${p.id}`} onClick={() => call("/api/admin/seo-engines", { action: "send-topic", id: p.id }, `t-${p.id}`)}>
                        Send to topic queue
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not a blog topic: build it as a {TYPE_WORDS[p.pageType]}</span>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">{p.evidence}</p>
                  {p.queries.length > 1 && <p className="mt-1 text-xs text-muted-foreground">Related searches: {p.queries.slice(0, 5).map((q) => `${q.query} (${q.impressions})`).join(", ")}</p>}
                </li>
              ))}
            </ul>
          )}
          {mining.refresh.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">Our pages almost on page one (refresh these)</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {mining.refresh.slice(0, 10).map((r) => (
                  <li key={r.path}>
                    <span className="font-medium">{r.path}</span> for "{r.query}": position {r.position}, {r.impressions} impressions
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-base font-semibold">Pages competing with each other</h2>
          <p className="text-sm text-muted-foreground">
            Two of our pages that both show in Google for the same search split their strength. One page is the primary; the others link to it (automatic, with Undo). Merging or retitling is only ever your call.
            {cannibal.at ? ` Last checked ${when(cannibal.at)}.` : ""}
          </p>
          {cannibal.findings.length === 0 ? (
            <p className="text-sm">No competing pages found (each page needs at least 10 impressions for the same search).</p>
          ) : (
            <ul className="space-y-3">
              {cannibal.findings.slice(0, 12).map((f) => (
                <li key={f.query} className="rounded border p-3 text-sm">
                  <p className="font-medium">"{f.query}" <span className="font-normal text-muted-foreground">({f.impressions} impressions)</span></p>
                  <p>Primary: <span className="font-medium">{f.primary.path}</span> ({f.primary.clicks} clicks, {f.primary.impressions} impressions, position {f.primary.position})</p>
                  <p>Others: {f.secondaries.map((s) => `${s.path} (${s.impressions})`).join(", ")}</p>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Needs you: differentiate, merge or canonical</summary>
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {f.suggestions.slice(0, 6).map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <h3 className="text-sm font-semibold">Links the engines added by themselves</h3>
          {decisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {decisions.map((d) => {
                const key = `${d.at}|${d.policy}|${d.subject}`
                return (
                  <li key={key} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {when(d.at)}: {d.action} <span className="text-muted-foreground">({d.reason})</span>
                      {d.undone_at && <span className="text-muted-foreground"> Undone.</span>}
                    </span>
                    {undoable(d) && (
                      <Button size="sm" variant="outline" disabled={busy === key} onClick={() => call("/api/admin/auto-decisions", { action: "undo", at: d.at, policy: d.policy, subject: d.subject }, key)}>
                        Undo
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <ul className="space-y-1">
            {switches.map((s) => (
              <li key={s.policy} className="flex items-center justify-between gap-3 text-sm">
                <span>{s.label} (up to {s.cap} a day)</span>
                <Button size="sm" variant={s.on ? "default" : "outline"} aria-pressed={s.on} disabled={busy === `sw-${s.policy}`} onClick={() => call("/api/admin/seo-engines", { action: "switch", policy: s.policy, on: !s.on }, `sw-${s.policy}`)}>
                  {s.on ? "On" : "Off"}
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-base font-semibold">Competitors</h2>
          <p className="text-sm text-muted-foreground">Up to {competitors.max} competitor websites. The scanner is polite (obeys robots.txt, one page a second, at most 40 pages each) and keeps only phrases and counts, never their text.</p>
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">{competitors.cannotRead}</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              call("/api/admin/seo-engines", { action: "competitor-add", url }, "add").then(() => setUrl(""))
            }}
          >
            <Input aria-label="Competitor website address" className="max-w-sm" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button type="submit" variant="outline" disabled={busy === "add" || !url.trim() || competitors.list.length >= competitors.max}>Add competitor</Button>
            <Button type="button" disabled={busy === "scan" || competitors.list.length === 0} onClick={() => scanAll(competitors.list)}>Scan competitors now</Button>
          </form>
          {competitors.list.length === 0 && <p className="text-sm">No competitors added yet.</p>}
          {competitors.list.map((origin) => {
            const c = competitors.state[hostOf(origin)]
            return (
              <div key={origin} className="rounded border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{hostOf(origin)}</span>
                  <Button size="sm" variant="outline" disabled={busy === `rm-${origin}`} onClick={() => call("/api/admin/seo-engines", { action: "competitor-remove", url: origin }, `rm-${origin}`)}>Remove</Button>
                </div>
                {!c ? (
                  <p className="text-muted-foreground">Not scanned yet. It is scanned automatically (one competitor a day, each once a week), or press Scan competitors now.</p>
                ) : (
                  <div className="mt-1 space-y-1">
                    <p className="text-muted-foreground">
                      Last scan {when(c.scannedAt)}: {c.pagesScanned} pages{c.complete ? "" : " (partial: more tomorrow)"}, {c.blockedByRobots} left alone because of robots.txt. {c.notes.join(" ")}
                    </p>
                    <p><span className="font-medium">Keyword gap</span> (they target it in titles, we have no page): {c.gaps.keyword.length ? c.gaps.keyword.slice(0, 10).map((k) => `${k.phrase} (${k.theirPages})`).join(", ") : "none found"}</p>
                    <p><span className="font-medium">Service and category gap</span>: {c.gaps.service.length ? c.gaps.service.slice(0, 12).map((s) => `${s.term} [${s.category}]`).join(", ") : "none found"}</p>
                    <p><span className="font-medium">Page types they have and we do not</span>: {c.gaps.contentType.length ? c.gaps.contentType.map((t) => `${t.type} (${t.theirPages})`).join(", ") : "none found"}</p>
                  </div>
                )}
              </div>
            )
          })}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border p-3 text-sm">
              <h3 className="font-semibold">By hand: their Google Business Profile</h3>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
                {competitors.manualSteps.businessProfile.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
            <div className="rounded border p-3 text-sm">
              <h3 className="font-semibold">By hand: their backlinks</h3>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
                {competitors.manualSteps.backlinks.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="text-base font-semibold">Hub and spoke map</h2>
          <p className="text-sm text-muted-foreground">
            For each topic: one hub page (the strongest) and the spoke pages around it. The hub should link to every spoke and every spoke back to the hub. Missing links are added by themselves a few a day (each with Undo).
            {hubspoke.at ? ` Last built ${when(hubspoke.at)}.` : ""}
          </p>
          {hubspoke.entries.length === 0 ? (
            <p className="text-sm">No topic has two or more pages yet.</p>
          ) : (
            <ul className="space-y-3">
              {hubspoke.entries.map((e) => (
                <li key={e.clusterId} className="rounded border p-3 text-sm">
                  <p className="font-medium">{e.topic}</p>
                  <p>Hub: <span className="font-medium">{e.hub.path}</span></p>
                  <p>Spokes: {e.spokes.map((s) => s.path).join(", ")}</p>
                  <p className="text-muted-foreground">Missing hub to spoke: {e.missingHubToSpoke.length ? e.missingHubToSpoke.join(", ") : "none"}. Missing spoke to hub: {e.missingSpokeToHub.length ? e.missingSpokeToHub.join(", ") : "none"}.</p>
                  {e.proposedHub && <p className="text-muted-foreground">Idea: a guide page about "{e.proposedHub.title}" would be a stronger hub than a blog post.</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
