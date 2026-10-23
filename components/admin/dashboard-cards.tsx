"use client"

import type { ReactNode } from "react"
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { Ga4RangeReport } from "@/lib/ga4"
import type { SearchRangeResult, VisitsRangeResult } from "@/lib/dashboard-data"
import { CHANNEL_COLORS, DASH_CHANNELS, SERIES_COLORS, RANGE_PHRASE, bucketLabel, legendEntries, type DashRange } from "@/lib/dashboard-range"

const tooltipStyle = { backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }
const CHART_H = "h-[300px]"

export type Loadable<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; message: string }

/** A number tile with a colour dot, the real window in small text, and a fixed height so nothing jumps while loading. */
export function StatTile({ label, value, note, color, loading }: { label: string; value: string | null; note: string; color: string; loading?: boolean }) {
  return (
    <Card>
      <CardContent className="min-h-[92px] p-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        </div>
        {loading ? <div className="mt-2 h-7 w-16 animate-pulse rounded bg-muted" /> : <p className="mt-1 text-2xl font-bold leading-none">{value ?? "n/a"}</p>}
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  )
}

function CardSkeleton({ title }: { title: string }) {
  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>Loading...</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`${CHART_H} w-full animate-pulse rounded-lg bg-muted`} />
      </CardContent>
    </Card>
  )
}

function ProblemCard({ title, text }: { title: string; text: ReactNode }) {
  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{text}</CardContent>
    </Card>
  )
}

// ---------- Website traffic, every channel ----------
export function TrafficCard({ range, state, notConnected, setupUrl }: { range: DashRange; state: Loadable<Ga4RangeReport>; notConnected: boolean; setupUrl: string }) {
  const title = "Website Traffic: All Sources"
  if (notConnected) {
    return (
      <ProblemCard
        title="Google Analytics is not connected"
        text={
          <p>
            No website traffic numbers are shown until it is connected. Nothing on this card is made up.{" "}
            <a className="font-medium text-primary underline" href={setupUrl} target="_blank" rel="noopener noreferrer">Open the Setup steps</a>{" "}
            and follow the Google Analytics step (GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_KEY).
          </p>
        }
      />
    )
  }
  if (state.kind === "loading") return <CardSkeleton title={title} />
  if (state.kind === "error") return <ProblemCard title="Google Analytics could not be read" text={<p>Google said no when we asked for the numbers ({state.message}). Check that the Google Analytics property number is right and that the service account email is a viewer in Google Analytics.</p>} />

  const report = state.data
  const legend = legendEntries(report.channelTotals)
  const drawn = legend.filter((l) => !l.none)
  const data = report.buckets.map((b) => ({ label: bucketLabel(b.key, report.bucket), ...b.channels }))
  const per = report.bucket === "day" ? "day" : report.bucket === "week" ? "week" : "month"

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription>
              Sessions by channel, {RANGE_PHRASE[range]}, one point per {per} · {report.totals.sessions.toLocaleString()} total
            </CardDescription>
          </div>
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            Live from GA4 · refreshed {new Date(report.fetchedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className={`${CHART_H} w-full`}>
          {drawn.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">Google Analytics counted no sessions in this range.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" minTickGap={24} />
                <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                {drawn.map((l) => (
                  <Area key={l.channel} type="monotone" dataKey={l.channel} name={l.channel} stroke={l.color} fill={l.color} fillOpacity={0.25} strokeWidth={2} stackId="traffic" />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        {/* Legend lists every channel, with its total, or "none yet". The text is the label so colour is never the only clue. */}
        <ul aria-label="Channels" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3 lg:grid-cols-5">
          {legend.map((l) => (
            <li key={l.channel} className="flex items-center gap-2">
              <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: l.color, opacity: l.none ? 0.35 : 1 }} />
              <span className={l.none ? "text-muted-foreground" : "font-medium"}>{l.channel}</span>
              <span className="text-muted-foreground">{l.none ? "none yet" : l.total.toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Google Analytics only counts visitors who accepted analytics, so it can be lower than real traffic. Channels are Google Analytics default channel groups.
        </p>
      </CardContent>
    </Card>
  )
}

// ---------- Google Search ----------
function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}

export function searchNote(range: DashRange, s: SearchRangeResult): string {
  if (s.source === "snapshot") return `28-day total from Search Console${s.snapshotDay ? ` (stored ${s.snapshotDay})` : ""}, not ${RANGE_PHRASE[range]}`
  if (s.source === "none") return "could not be read"
  return `${s.startDate} to ${s.endDate}${s.clamped ? " (Search Console keeps 16 months)" : ""}, ends 2 days ago`
}

export function SearchCard({ range, state }: { range: DashRange; state: Loadable<SearchRangeResult> }) {
  const title = "Google Search: clicks and impressions"
  if (state.kind === "loading") return <CardSkeleton title={title} />
  if (state.kind === "error") return <ProblemCard title="Google Search could not be read" text={<p>{state.message}</p>} />
  const s = state.data
  const data = s.points.map((p) => ({ label: bucketLabel(p.key, s.bucket), clicks: p.clicks, impressions: p.impressions }))

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          {s.source === "live" ? `Search Console, ${searchNote(range, s)}.` : s.source === "snapshot" ? `Search Console could not be read live, so this is the ${searchNote(range, s)}.` : "Search Console could not be read and no stored snapshot exists yet."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {s.error && s.source !== "live" && <p className="mb-2 text-xs text-muted-foreground">Reason: {s.error}</p>}
        {s.source === "live" && s.totals && (
          <>
            <div className={`${CHART_H} w-full`}>
              {data.length === 0 ? (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">Google reported no search data for this range.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" minTickGap={24} />
                    <YAxis yAxisId="clicks" tick={{ fontSize: 12 }} allowDecimals={false} stroke={SERIES_COLORS.clicks} />
                    <YAxis yAxisId="impr" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} stroke={SERIES_COLORS.impressions} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Line yAxisId="clicks" type="monotone" dataKey="clicks" name="Clicks (left axis)" stroke={SERIES_COLORS.clicks} strokeWidth={2} dot={false} />
                    <Line yAxisId="impr" type="monotone" dataKey="impressions" name="Impressions (right axis)" stroke={SERIES_COLORS.impressions} strokeWidth={2} dot={false} strokeDasharray="5 3" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <li className="flex items-center gap-2"><span aria-hidden className="h-3 w-3 rounded-sm" style={{ backgroundColor: SERIES_COLORS.clicks }} />Clicks (left axis) <span className="text-muted-foreground">{s.totals.clicks.toLocaleString()}</span></li>
              <li className="flex items-center gap-2"><span aria-hidden className="h-3 w-3 rounded-sm" style={{ backgroundColor: SERIES_COLORS.impressions }} />Impressions (right axis, dashed) <span className="text-muted-foreground">{s.totals.impressions.toLocaleString()}</span></li>
            </ul>
          </>
        )}
        {s.source === "snapshot" && s.totals && (
          <p className="text-sm">
            {s.totals.clicks.toLocaleString()} clicks and {s.totals.impressions.toLocaleString()} impressions in the last 28 days (stored snapshot). The chart needs a live read.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------- First-party visits ----------
export function VisitsCard({ range, state }: { range: DashRange; state: Loadable<VisitsRangeResult> }) {
  const title = "Visits recorded by this site"
  if (state.kind === "loading") return <CardSkeleton title={title} />
  if (state.kind === "error") return <ProblemCard title="Recorded visits could not be read" text={<p>{state.message}</p>} />
  const v = state.data
  if (!v.trackingOn) {
    return <ProblemCard title={title} text={<p>Visit tracking is switched off, so this site records no visits of its own. The switch is in System health. Google Analytics above still counts visitors who accepted analytics.</p>} />
  }
  if (v.error) return <ProblemCard title="Recorded visits could not be read" text={<p>{v.error}</p>} />
  const data = v.points.map((p) => ({ label: bucketLabel(p.key, v.bucket), visits: p.total }))
  const totals = v.channelTotals ? DASH_CHANNELS.map((c) => ({ channel: c, total: v.channelTotals![c] })).filter((c) => c.total > 0) : []

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          First-party visits, {RANGE_PHRASE[range]} · {v.total.toLocaleString()} total. Recorded after consent, so lower than Google Analytics.
          {range === "all" ? ` Visits older than ${v.retentionMonths} months are deleted, so all time reaches back at most that far.` : ""}
          {v.capped ? " Showing the newest 20,000 visits only." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[220px] w-full">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No visits recorded in this range yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" minTickGap={24} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} className="fill-muted-foreground" />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="visits" name="Visits recorded by this site" stroke={SERIES_COLORS.visits} fill={SERIES_COLORS.visits} fillOpacity={0.25} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        {totals.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {totals.map((c) => (
              <li key={c.channel} className="flex items-center gap-2">
                <span aria-hidden className="h-3 w-3 rounded-sm" style={{ backgroundColor: CHANNEL_COLORS[c.channel] }} />
                {c.channel} <span className="text-muted-foreground">{c.total.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
