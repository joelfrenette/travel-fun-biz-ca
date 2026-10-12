"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Search, Globe, Users, Activity } from "lucide-react"
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts"
import { adminTools } from "@/lib/admin-nav"
import type { Ga4Report } from "@/lib/ga4"
import { FunnelPanel } from "@/components/admin/funnel-panel"

const channelColors: Record<string, string> = {
  google: "#4285F4", direct: "#34A853", email: "#FBBC05", facebook: "#1877F2", instagram: "#E4405F",
  tiktok: "#000000", twitter: "#1DA1F2", pinterest: "#E60023", other: "#9CA3AF",
  "Organic Search": "#4285F4", "Direct": "#34A853", "Organic Social": "#E4405F", "Paid Social": "#C13584",
  "Paid Search": "#0F9D58", "Email": "#FBBC05", "Referral": "#7C3AED", "Organic Video": "#FF0000", "Other": "#9CA3AF",
}

// Setup checklist Joel follows (grade-5 steps for every account and key).
const SETUP_STEPS_URL = "https://claude.ai/artifact/PN6caspQe9V6RUUsJ2vNcw"

// "not_connected" = GA4 keys are not set. "error" = keys are set but Google said no. Neither shows numbers.
type AnalyticsState =
  | { kind: "loading" }
  | { kind: "not_connected" }
  | { kind: "error"; message: string }
  | { kind: "live"; report: Ga4Report }

function Ga4NotConnected({ state }: { state: AnalyticsState }) {
  const isError = state.kind === "error"
  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">{isError ? "Google Analytics could not be read" : "Google Analytics is not connected"}</CardTitle>
        <CardDescription>No website traffic numbers are shown here until it is connected. Nothing on this card is made up.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isError ? (
          <p>Google said no when we asked for the numbers ({state.message}). Check that the Google Analytics property number is right and that the service account email has been added as a viewer in Google Analytics.</p>
        ) : (
          <p>Google Analytics is the free tool that counts the people who visit your website. Once you connect it, this page will show real visits for the last 14 days, split by where they came from.</p>
        )}
        <p>
          <a className="font-medium text-primary underline" href={SETUP_STEPS_URL} target="_blank" rel="noopener noreferrer">Open the Setup steps</a>
          {" "}and follow the Google Analytics step. It tells you which two settings to add in Vercel (GA4_PROPERTY_ID and GOOGLE_SERVICE_ACCOUNT_KEY).
        </p>
      </CardContent>
    </Card>
  )
}

function formatDay(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? yyyymmdd : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" })
}

// ─── Traffic Analytics Chart ────────────────────────────────────────
function TrafficChart({ state }: { state: AnalyticsState }) {
  if (state.kind === "not_connected" || state.kind === "error") return <Ga4NotConnected state={state} />
  if (state.kind === "loading") {
    return (
      <Card className="col-span-full">
        <CardContent className="p-6 text-sm text-muted-foreground">Loading Google Analytics…</CardContent>
      </Card>
    )
  }
  const live = state.report
  const channels = Object.keys(live.days[0]?.channels || {}).filter((c) => live.days.some((d) => d.channels[c as keyof typeof d.channels] > 0))
  const data: Record<string, string | number>[] = live.days.map((d) => ({ date: formatDay(d.date), ...d.channels }))
  const total = data.reduce((sum, day) => sum + channels.reduce((s, ch) => s + (Number(day[ch]) || 0), 0), 0)

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">Website Traffic — All Sources</CardTitle>
            <CardDescription>Sessions by channel (last 14 days) · {total.toLocaleString()} total</CardDescription>
          </div>
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Live from GA4 · refreshed {new Date(live.fetchedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
              <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" />
              <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              {channels.map((channel) => (
                <Area
                  key={channel}
                  type="monotone"
                  dataKey={channel}
                  name={channel}
                  stroke={channelColors[channel] || "#9CA3AF"}
                  fill={channelColors[channel] || "#9CA3AF"}
                  fillOpacity={0.1}
                  strokeWidth={2}
                  stackId="traffic"
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Admin Dashboard ────────────────────────────────────────────────
export default function AdminPage() {
  const router = useRouter()
  const [analytics, setAnalytics] = useState<AnalyticsState>({ kind: "loading" })

  useEffect(() => {
    fetch("/api/admin/analytics", { headers: { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (data.configured === false) return setAnalytics({ kind: "not_connected" })
        if (!res.ok || data.error) return setAnalytics({ kind: "error", message: data.error || `HTTP ${res.status}` })
        setAnalytics({ kind: "live", report: data })
      })
      .catch(() => setAnalytics({ kind: "error", message: "network error" }))
  }, [])

  const live = analytics.kind === "live" ? analytics.report.totals : null
  const quickStats = live
    ? [
        { label: "Sessions (14d)", value: live.sessions.toLocaleString(), icon: Activity },
        { label: "Users (14d)", value: live.users.toLocaleString(), icon: Users },
        { label: "Organic search sessions", value: live.organicSearch.toLocaleString(), icon: Search },
        { label: "Social sessions", value: live.social.toLocaleString(), icon: Globe },
      ]
    : []

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Welcome back 👋</h2>
        <p className="mt-1 text-muted-foreground">Your AI-powered travel business command center.</p>
      </div>

      {quickStats.length > 0 && <div className="mb-6 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {quickStats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-lg bg-primary/10 p-2">
                <stat.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold leading-none">{stat.value}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>}

      <div className="mb-8">
        <TrafficChart state={analytics} />
      </div>

      <div className="mb-8">
        <FunnelPanel />
      </div>

      <div className="mb-4">
        <h3 className="text-lg font-semibold">Admin Tools</h3>
        <p className="text-sm text-muted-foreground">Select a tool to get started. Features will be activated as we build them together.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {adminTools.map((tool) => (
          <Card
            key={tool.title}
            className={`group relative overflow-hidden transition-shadow hover:shadow-lg ${tool.href ? "cursor-pointer" : ""}`}
            onClick={() => tool.href && router.push(tool.href)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="rounded-lg bg-primary/10 p-2">
                  <tool.icon className="h-5 w-5 text-primary" />
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  tool.status === "Active"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {tool.status}
                </span>
              </div>
              <CardTitle className="mt-3 text-base">{tool.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{tool.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
