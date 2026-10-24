"use client"

import { useMemo, useState } from "react"
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { SearchRangeResult } from "@/lib/dashboard-data"
import { RANGE_PHRASE, type DashRange } from "@/lib/dashboard-range"
import {
  EXTRA_DEFAULT_HIDDEN, EXTRA_IDS, SERIES_SPECS, TOTAL_ID, buildTrafficSeries, extraLines, toggleHidden, tooltipBreakdown, unavailableNote,
  type ChannelKey, type GaInput, type SearchInput, type SeriesId, type TrafficChart, type TrafficRow, type VisitsInput,
} from "@/lib/traffic-series"

const CHART_H = "h-[300px] sm:h-[380px]"

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

interface TipProps {
  active?: boolean
  payload?: Array<{ payload?: TrafficRow }>
  chart: TrafficChart
}

/** The tooltip: the day, every source with its sessions and its share of that day, and the total. */
function TrafficTip({ active, payload, chart }: TipProps) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  const { total, lines } = tooltipBreakdown(row, chart.channels)
  const extras = extraLines(chart, []).filter((s) => typeof row[s.id] === "number")
  return (
    <div className="rounded-lg border bg-card p-2.5 text-xs shadow-md" data-testid="traffic-tooltip">
      <p className="mb-1 font-semibold">{row.label}</p>
      {lines.length === 0 && chart.channels.length > 0 && <p className="text-muted-foreground">No sessions</p>}
      {lines.map((l) => (
        <p key={l.label} className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: l.color }} />
          <span className="min-w-0 flex-1">{l.label}</span>
          <span className="font-medium tabular-nums">{l.value.toLocaleString()}</span>
          <span className="w-9 text-right tabular-nums text-muted-foreground">{l.share}%</span>
        </p>
      ))}
      {chart.channels.length > 0 && (
        <p className="mt-1 flex items-center gap-2 border-t pt-1 font-semibold">
          <span className="flex-1">Total</span>
          <span className="tabular-nums">{total.toLocaleString()}</span>
        </p>
      )}
      {extras.map((s) => (
        <p key={s.id} className="mt-0.5 flex items-center gap-2 text-muted-foreground">
          <span aria-hidden className="h-0.5 w-2.5 shrink-0" style={{ backgroundColor: s.color }} />
          <span className="flex-1">{s.label.replace(" (right scale)", "")}</span>
          <span className="tabular-nums">{(row[s.id] ?? 0).toLocaleString()}</span>
        </p>
      ))}
    </div>
  )
}

/** The first chart on the dashboard: combined traffic from every source, colour coded. One coloured layer per source (organic search,
 * direct, referral, social and so on) is stacked, and the total is a line on top. Hovering a point lists each source with its value
 * and share. Under the chart a colour legend gives each source's total for the range; each name is a button that hides or shows its
 * layer. Users, Google Search clicks and impressions, and the visits this site recorded are extra lines, off at first. A source that
 * cannot be read is named under the chart, never drawn as a zero. */
export function TrafficChartCard({ range, bucket, inputs, setupUrl }: { range: DashRange; bucket: "day" | "week" | "month"; inputs: TrafficInputs; setupUrl: string }) {
  const title = "Traffic from all sources"
  const [hiddenLayers, setHiddenLayers] = useState<ChannelKey[]>([])
  const [hiddenExtras, setHiddenExtras] = useState<SeriesId[] | null>(null)
  const [totalOff, setTotalOff] = useState(false)
  const chart = useMemo(
    () => (inputs.ga && inputs.search && inputs.visits ? buildTrafficSeries(bucket, inputs.ga, inputs.search, inputs.visits) : null),
    [bucket, inputs.ga, inputs.search, inputs.visits],
  )
  if (!chart) return <CardSkeleton title={title} />

  const stacked = chart.channels.length > 0
  // With no source breakdown (Google Analytics not readable) the extra lines are all there is, so they start switched on.
  const extrasHidden = hiddenExtras ?? (stacked ? EXTRA_DEFAULT_HIDDEN : [])
  const lines = extraLines(chart, extrasHidden)
  const rightOn = lines.some((s) => s.axis === "right")
  const layers = chart.channels.filter((c) => !hiddenLayers.includes(c.key))
  const totalSeries = chart.series.find((s) => s.id === TOTAL_ID)!
  const drawTotal = stacked && !totalOff
  const anything = layers.length > 0 || lines.length > 0 || drawTotal
  const note = unavailableNote({ ...chart, unavailable: chart.unavailable.filter((u) => u.id === TOTAL_ID || (EXTRA_IDS as readonly string[]).includes(u.id)) })
  const gaMissing = inputs.ga?.status === "not_connected"
  const per = bucket === "day" ? "day" : bucket === "week" ? "week" : "month"

  return (
    <Card className="col-span-full" data-testid="traffic-chart">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          Every visit counted, {RANGE_PHRASE[range]}, one point per {per}. Each colour is where the visitors came from; the line on top is the total. Touch or hover a point to see each source. Tap a name below to hide or show it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className={`${CHART_H} w-full`}>
          {!chart.hasData ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              {chart.series.some((s) => s.available) ? "No traffic was counted in this range." : "No traffic source could be read, so there is nothing to draw."}
            </div>
          ) : !anything ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Everything is switched off. Tap a name below to bring it back.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart.rows} margin={{ top: 5, right: rightOn ? 4 : 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" minTickGap={24} />
                <YAxis yAxisId="left" tick={{ fontSize: 12 }} allowDecimals={false} width={40} className="fill-muted-foreground" />
                {rightOn && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} width={44} className="fill-muted-foreground" />}
                <Tooltip content={<TrafficTip chart={chart} />} />
                {layers.map((c) => (
                  <Area key={c.key} yAxisId="left" type="monotone" dataKey={c.key} name={c.channel} stackId="sources" stroke={c.color} fill={c.color} fillOpacity={0.55} strokeWidth={1} isAnimationActive={false} />
                ))}
                {drawTotal && <Line yAxisId="left" type="monotone" dataKey={TOTAL_ID} name={totalSeries.label} stroke="currentColor" className="text-foreground" strokeWidth={2.5} dot={false} isAnimationActive={false} />}
                {lines.map((s) => (
                  <Line key={s.id} yAxisId={s.axis} type="monotone" dataKey={s.id} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} dot={false} connectNulls isAnimationActive={false} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* The colour legend: each source with its total and share for the range. Each name is a real button, so colour is never the only clue. */}
        {stacked ? (
          <ul aria-label="Traffic sources" data-testid="source-legend" className="mt-3 grid grid-cols-1 gap-1.5 text-xs min-[420px]:grid-cols-2 lg:grid-cols-3">
            {chart.channels.map((c) => {
              const off = hiddenLayers.includes(c.key)
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    onClick={() => setHiddenLayers((h) => (h.includes(c.key) ? h.filter((k) => k !== c.key) : [...h, c.key]))}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md border px-2 py-1 text-left hover:bg-muted"
                  >
                    <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: c.color, opacity: off ? 0.3 : 1 }} />
                    <span className={`min-w-0 flex-1 ${off ? "text-muted-foreground line-through" : "font-medium"}`}>{c.channel}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{c.total.toLocaleString()} · {c.share}%</span>
                  </button>
                </li>
              )
            })}
            <li>
              <button type="button" aria-pressed={!totalOff} onClick={() => setTotalOff((v) => !v)} className="flex min-h-9 w-full items-center gap-2 rounded-md border px-2 py-1 text-left hover:bg-muted">
                <svg aria-hidden width="22" height="8" className="shrink-0">
                  <line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" strokeWidth="3" opacity={totalOff ? 0.3 : 1} />
                </svg>
                <span className={`min-w-0 flex-1 ${totalOff ? "text-muted-foreground line-through" : "font-semibold"}`}>Total</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{(totalSeries.total ?? 0).toLocaleString()}</span>
              </button>
            </li>
          </ul>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            The colour-coded breakdown by source needs Google Analytics, which could not be read, so no sources are drawn. The lines below are what could be read.
          </p>
        )}

        <p className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Extra lines</p>
        <ul aria-label="Extra traffic lines" className="grid grid-cols-1 gap-1.5 text-xs min-[420px]:grid-cols-2 lg:grid-cols-4">
          {chart.series
            .filter((s) => (EXTRA_IDS as readonly string[]).includes(s.id))
            .map((s) => {
              const off = extrasHidden.includes(s.id)
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!s.available}
                    aria-pressed={s.available ? !off : undefined}
                    onClick={() => setHiddenExtras(toggleHidden(extrasHidden, s.id))}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md border px-2 py-1 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <svg aria-hidden width="22" height="8" className="shrink-0">
                      <line x1="0" y1="4" x2="22" y2="4" stroke={SERIES_SPECS[s.id].color} strokeWidth="3" strokeDasharray={s.dash} opacity={s.available && !off ? 1 : 0.3} />
                    </svg>
                    <span className={`min-w-0 flex-1 ${s.available && !off ? "font-medium" : "text-muted-foreground line-through"}`}>{s.label.replace(" (right scale)", "")}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{s.available ? (s.total ?? 0).toLocaleString() : "n/a"}</span>
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
