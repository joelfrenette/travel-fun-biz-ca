"use client"

import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { TopPagesResponse, TopPostsResponse } from "@/lib/dashboard-top-data"
import { TOP_PAGE_TYPE_LABELS, type BestPick } from "@/lib/dashboard-top"
import { RANGE_PHRASE, type DashRange } from "@/lib/dashboard-range"
import type { Loadable } from "@/components/admin/dashboard-cards"

const COULD_NOT = "could not be read"

function TableSkeleton({ title }: { title: string }) {
  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>Loading...</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-7 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  )
}

/** A table that scrolls sideways inside its card, so the page itself never overflows on a phone. */
function Scroller({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-md border">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">{children}</table>
    </div>
  )
}

const th = "whitespace-nowrap border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
const td = "border-b px-3 py-2 align-top last:border-b-0"
const num = "whitespace-nowrap text-right tabular-nums"

function Count({ value }: { value: number | null }) {
  return value === null ? <span className="text-muted-foreground">{COULD_NOT}</span> : <>{value.toLocaleString()}</>
}

// ---------- Top pages ----------
export function TopPagesCard({ range, state }: { range: DashRange; state: Loadable<TopPagesResponse> }) {
  const title = "Top pages"
  if (state.kind === "loading") return <TableSkeleton title={title} />
  if (state.kind === "error") return <Problem title="Top pages could not be read"><p>{state.message}</p></Problem>
  const d = state.data
  const showRecorded = d.recorded.status === "ok"
  const showGa4 = d.ga4.status === "ok"
  const phrase = RANGE_PHRASE[range]

  const notes: string[] = []
  if (d.recorded.status === "off") notes.push("Visit tracking is off, so there are no recorded visits.")
  if (d.recorded.status === "error") notes.push(`Recorded visits ${COULD_NOT} (${d.recorded.error}).`)
  if (d.ga4.status === "not_connected") notes.push("Google Analytics is not connected, so there are no GA4 views.")
  if (d.ga4.status === "error") notes.push(`GA4 views ${COULD_NOT} (${d.ga4.error}).`)
  if (d.leads.status === "error") notes.push(`Leads ${COULD_NOT} (${d.leads.error}).`)

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          The 10 pages with the most visits, {phrase}.{" "}
          {d.shareBasis === "recorded" ? "Ranked by recorded visits." : d.shareBasis === "ga4" ? "Ranked by GA4 views." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {notes.length > 0 && (
          <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        {d.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {d.recorded.status === "ok" || d.ga4.status === "ok" ? "No page visits were counted in this range." : "No visit source could be read, so there is nothing to rank yet."}
          </div>
        ) : (
          <Scroller>
            <thead>
              <tr>
                <th className={th}>Page</th>
                <th className={th}>Type</th>
                <th className={`${th} text-right`}>GA4 views</th>
                <th className={`${th} text-right`}>Recorded visits</th>
                <th className={`${th} text-right`}>Share</th>
                <th className={th}>Top source</th>
                <th className={`${th} text-right`}>Leads</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.path}>
                  <td className={`${td} max-w-[260px] break-all`}>
                    <a className="font-medium text-primary underline" href={r.path} target="_blank" rel="noopener noreferrer">
                      {r.path}
                    </a>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{TOP_PAGE_TYPE_LABELS[r.pageType]}</td>
                  <td className={`${td} ${num}`}>{d.ga4.status === "not_connected" ? <span className="text-muted-foreground">not connected</span> : <Count value={r.ga4Views} />}</td>
                  <td className={`${td} ${num}`}>{d.recorded.status === "off" ? <span className="text-muted-foreground">tracking off</span> : <Count value={r.recordedVisits} />}</td>
                  <td className={`${td} ${num}`}>{r.share === null ? <span className="text-muted-foreground">n/a</span> : `${(r.share * 100).toFixed(1)}%`}</td>
                  <td className={td}>{showRecorded ? r.topSource ?? <span className="text-muted-foreground">none named</span> : <span className="text-muted-foreground">n/a</span>}</td>
                  <td className={`${td} ${num}`}><Count value={r.leads} /></td>
                </tr>
              ))}
            </tbody>
          </Scroller>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Recorded visits are counted by this site only after the visitor accepted analytics, and count the page each visit started on.
          {showGa4 ? " GA4 views count every page seen, so the two columns will not match." : ""} Share is of {d.shareBasis === "ga4" ? "all GA4 views" : "all recorded visits"}. Query strings and trailing slashes are ignored.
          {d.pagesCounted > d.rows.length ? ` Showing ${d.rows.length} of ${d.pagesCounted} pages.` : ""}
        </p>
      </CardContent>
    </Card>
  )
}

// ---------- Top posts by clicks ----------
function Best({ label, pick }: { label: string; pick: BestPick }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {pick.enough ? (
        <>
          <p className="mt-1 text-lg font-bold">{pick.name}</p>
          <p className="text-[11px] text-muted-foreground">
            {pick.visitsPerSend} visits per send ({pick.visits.toLocaleString()} visits from {pick.sends} sends)
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-lg font-bold text-muted-foreground">not enough data yet</p>
          <p className="text-[11px] text-muted-foreground">Needs at least {pick.needed} sends to be named ({pick.sends} so far).</p>
        </>
      )}
    </div>
  )
}

export function TopPostsCard({ range, state }: { range: DashRange; state: Loadable<TopPostsResponse> }) {
  const title = "Top posts by clicks"
  if (state.kind === "loading") return <TableSkeleton title={title} />
  if (state.kind === "error") return <Problem title="Top posts could not be read"><p>{state.message}</p></Problem>
  const d = state.data
  const phrase = RANGE_PHRASE[range]

  const notes: string[] = []
  if (d.leads.status === "error") notes.push(`Leads ${COULD_NOT} (${d.leads.error}).`)
  if (d.sends.status === "error") notes.push(`Sends ${COULD_NOT} (${d.sends.error}), so the best-of summaries are not shown.`)

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>Social posts, networks and hook styles that sent visits, {phrase}.</CardDescription>
      </CardHeader>
      <CardContent>
        {d.visits.status === "off" && (
          <p className="mb-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Visit tracking is off, so clicks from social posts are not recorded. Leads are still listed when a post's tag came with them.</p>
        )}
        {d.visits.status === "error" && <p className="mb-3 text-sm text-muted-foreground">Recorded visits {COULD_NOT} ({d.visits.error}).</p>}
        {notes.length > 0 && (
          <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Best label="Best hook style (visits per send)" pick={d.bestHookStyle} />
          <Best label="Best network (visits per send)" pick={d.bestNetwork} />
        </div>
        {d.rows.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {d.visits.status === "ok" ? "No visits from social posts were recorded in this range." : "There are no social post rows to show for this range."}
          </div>
        ) : (
          <Scroller>
            <thead>
              <tr>
                <th className={th}>Post</th>
                <th className={th}>Network</th>
                <th className={th}>Hook style</th>
                <th className={th}>Format</th>
                <th className={`${th} text-right`}>Visits</th>
                <th className={`${th} text-right`}>Leads</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={`${r.slug}|${r.network}|${r.hookStyle}|${r.format}`}>
                  <td className={`${td} max-w-[280px]`}>
                    <a className="font-medium text-primary underline" href={`/blog/${r.slug}`} target="_blank" rel="noopener noreferrer">
                      {r.title}
                    </a>
                    {!r.titleFound && <span className="block text-[11px] text-muted-foreground">title not found, showing the slug</span>}
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{r.network}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.hookStyle ?? <span className="text-muted-foreground">none recorded</span>}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.format ?? <span className="text-muted-foreground">none recorded</span>}</td>
                  <td className={`${td} ${num}`}>{d.visits.status === "off" ? <span className="text-muted-foreground">tracking off</span> : <Count value={r.visits} />}</td>
                  <td className={`${td} ${num}`}><Count value={r.leads} /></td>
                </tr>
              ))}
            </tbody>
          </Scroller>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Visits are recorded after consent and matched on the link tags (utm_campaign is the post, utm_source the network, utm_content the hook style and format).
          Visits per send uses photo post, guide, trip, news and recap sends from the distribution log; carousel and video sends are not in it. A name needs 5 sends to be ranked.
          {d.rowsCounted > d.rows.length ? ` Showing ${d.rows.length} of ${d.rowsCounted} rows.` : ""}
        </p>
      </CardContent>
    </Card>
  )
}
