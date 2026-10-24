"use client"

import { useMemo, useState } from "react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { SearchRangeResult } from "@/lib/dashboard-data"
import { RANGE_PHRASE, type DashRange } from "@/lib/dashboard-range"
import { buildTrafficSeries, toggleHidden, unavailableNote, visibleSeries, type GaInput, type SearchInput, type SeriesId, type VisitsInput } from "@/lib/traffic-series"

const tooltipStyle = { backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }
const CHART_H = "h-[300px] sm:h-[360px]"

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

// ---------- Google Search wording (used by the tiles) ----------
export function searchNote(range: DashRange, s: SearchRangeResult): string {
  if (s.source === "snapshot") return `28-day total from Search Console${s.snapshotDay ? ` (stored ${s.snapshotDay})` : ""}, not ${RANGE_PHRASE[range]}`
  if (s.source === "none") return "could not be read"
  return `${s.startDate} to ${s.endDate}${s.clamped ? " (Search Console keeps 16 months)" : ""}, ends 2 days ago`
}

// ---------- ONE traffic chart ----------
export interface TrafficInputs {
  /** null while that source is still loading. */
  ga: GaInput | null
  search: SearchInput | null
  visits: VisitsInput | null
}

/** Every traffic series on one time axis: Google Analytics sessions, users and channels, Google Search clicks and impressions, and
 * the visits this site recorded. A legend of buttons switches each line on or off. Impressions use their own scale on the right so
 * they cannot flatten the clicks. A line that cannot be drawn (not connected, switched off, could not be read) is named under the chart. */
export function TrafficChartCard({ range, bucket, inputs, setupUrl }: { range: DashRange; bucket: "day" | "week" | "month"; inputs: TrafficInputs; setupUrl: string }) {
  const title = "Traffic"
  const [hidden, setHidden] = useState<SeriesId[]>([])
  const chart = useMemo(
    () => (inputs.ga && inputs.search && inputs.visits ? buildTrafficSeries(bucket, inputs.ga, inputs.search, inputs.visits) : null),
    [bucket, inputs.ga, inputs.search, inputs.visits],
  )
  if (!chart) return <CardSkeleton title={title} />

  const drawn = visibleSeries(chart, hidden)
  const rightOn = drawn.some((s) => s.axis === "right")
  const note = unavailableNote(chart)
  const gaMissing = inputs.ga?.status === "not_connected"
  const per = bucket === "day" ? "day" : bucket === "week" ? "week" : "month"

  return (
    <Card className="col-span-full" data-testid="traffic-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          Everything that counts visitors, together, {RANGE_PHRASE[range]}, one point per {per}. Tap a name below to switch its line on or off.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`${CHART_H} w-full`}>
          {!chart.hasData ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              {chart.series.some((s) => s.available) ? "No traffic was counted in this range." : "No traffic source could be read, so there is nothing to draw."}
            </div>
          ) : drawn.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Every line is switched off. Tap a name below to bring one back.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart.rows} margin={{ top: 5, right: rightOn ? 4 : 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" minTickGap={24} />
                <YAxis yAxisId="left" tick={{ fontSize: 12 }} allowDecimals={false} width={40} className="fill-muted-foreground" />
                {rightOn && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} width={44} className="fill-muted-foreground" />}
                <Tooltip contentStyle={tooltipStyle} />
                {drawn.map((s) => (
                  <Line key={s.id} yAxisId={s.axis} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} dot={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* The legend is the switch panel. Each name is a real button, so the colour is never the only clue and a phone thumb can hit it. */}
        <ul aria-label="Traffic lines" className="mt-3 grid grid-cols-1 gap-1.5 text-xs min-[420px]:grid-cols-2 lg:grid-cols-3">
          {chart.series.map((s) => {
            const off = hidden.includes(s.id)
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!s.available}
                  aria-pressed={s.available ? !off : undefined}
                  onClick={() => setHidden((h) => toggleHidden(h, s.id))}
                  className="flex min-h-9 w-full items-center gap-2 rounded-md border px-2 py-1 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg aria-hidden width="22" height="8" className="shrink-0">
                    <line x1="0" y1="4" x2="22" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash} opacity={s.available && !off ? 1 : 0.3} />
                  </svg>
                  <span className={`min-w-0 flex-1 ${s.available && !off ? "font-medium" : "text-muted-foreground line-through"}`}>{s.label}</span>
                  <span className="shrink-0 text-muted-foreground">{s.available ? (s.total ?? 0).toLocaleString() : "n/a"}</span>
                </button>
              </li>
            )
          })}
        </ul>

        {note && <p className="mt-3 text-[11px] leading-snug text-muted-foreground">{note}</p>}
        {gaMissing && (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Google Analytics is not connected.{" "}
            <a className="font-medium text-primary underline" href={setupUrl} target="_blank" rel="noopener noreferrer">Open the Setup steps</a>{" "}
            and follow the Google Analytics step (GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_KEY).
          </p>
        )}
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Google Analytics and this site only count visitors who accepted analytics, so they can be lower than real traffic. Google Search counts searches, not visits.
        </p>
      </CardContent>
    </Card>
  )
}
