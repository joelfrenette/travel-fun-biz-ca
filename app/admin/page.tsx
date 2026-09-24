"use client"

import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Search, Globe, Cookie, Users } from "lucide-react"
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts"
import { adminTools } from "@/lib/admin-nav"

// ─── Sample analytics data (replace with real GA data later) ────────
const trafficData = [
  { date: "Mar 1", google: 42, direct: 18, email: 8, facebook: 12, instagram: 6, tiktok: 3, twitter: 2, pinterest: 4, other: 5 },
  { date: "Mar 2", google: 55, direct: 22, email: 12, facebook: 15, instagram: 8, tiktok: 5, twitter: 3, pinterest: 6, other: 7 },
  { date: "Mar 3", google: 48, direct: 20, email: 6, facebook: 18, instagram: 10, tiktok: 7, twitter: 4, pinterest: 5, other: 4 },
  { date: "Mar 4", google: 62, direct: 25, email: 15, facebook: 22, instagram: 12, tiktok: 8, twitter: 5, pinterest: 7, other: 9 },
  { date: "Mar 5", google: 71, direct: 28, email: 10, facebook: 19, instagram: 14, tiktok: 11, twitter: 6, pinterest: 8, other: 6 },
  { date: "Mar 6", google: 58, direct: 24, email: 18, facebook: 25, instagram: 16, tiktok: 9, twitter: 4, pinterest: 10, other: 8 },
  { date: "Mar 7", google: 85, direct: 32, email: 22, facebook: 28, instagram: 18, tiktok: 14, twitter: 7, pinterest: 12, other: 11 },
  { date: "Mar 8", google: 78, direct: 30, email: 14, facebook: 20, instagram: 15, tiktok: 10, twitter: 5, pinterest: 9, other: 7 },
  { date: "Mar 9", google: 92, direct: 35, email: 25, facebook: 32, instagram: 20, tiktok: 16, twitter: 8, pinterest: 14, other: 13 },
  { date: "Mar 10", google: 68, direct: 27, email: 11, facebook: 17, instagram: 13, tiktok: 7, twitter: 3, pinterest: 6, other: 5 },
  { date: "Mar 11", google: 74, direct: 29, email: 19, facebook: 24, instagram: 17, tiktok: 12, twitter: 6, pinterest: 11, other: 10 },
  { date: "Mar 12", google: 88, direct: 33, email: 20, facebook: 30, instagram: 22, tiktok: 15, twitter: 9, pinterest: 13, other: 12 },
  { date: "Mar 13", google: 95, direct: 38, email: 28, facebook: 35, instagram: 25, tiktok: 18, twitter: 10, pinterest: 15, other: 14 },
  { date: "Mar 14", google: 82, direct: 31, email: 16, facebook: 21, instagram: 19, tiktok: 13, twitter: 7, pinterest: 10, other: 9 },
]

const channelColors: Record<string, string> = {
  google: "#4285F4",
  direct: "#34A853",
  email: "#FBBC05",
  facebook: "#1877F2",
  instagram: "#E4405F",
  tiktok: "#000000",
  twitter: "#1DA1F2",
  pinterest: "#E60023",
  other: "#9CA3AF",
}

// ─── Traffic Analytics Chart ────────────────────────────────────────
function TrafficChart() {
  const channels = Object.keys(channelColors)
  const totalClicks = trafficData.reduce((sum, day) => {
    return sum + channels.reduce((s, ch) => s + ((day as any)[ch] || 0), 0)
  }, 0)

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Website Traffic — All Sources</CardTitle>
            <CardDescription>Clicks by referrer channel (last 14 days) · {totalClicks.toLocaleString()} total clicks</CardDescription>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            Sample Data — Connect Google Analytics to see real data
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trafficData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
              <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              {channels.map((channel) => (
                <Area
                  key={channel}
                  type="monotone"
                  dataKey={channel}
                  name={channel.charAt(0).toUpperCase() + channel.slice(1)}
                  stroke={channelColors[channel]}
                  fill={channelColors[channel]}
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

// ─── Quick Stats Row ────────────────────────────────────────────────
const quickStats = [
  { label: "Total Visitors (14d)", value: "1,247", icon: Users, change: "+12%" },
  { label: "Google Clicks", value: "902", icon: Search, change: "+8%" },
  { label: "Social Referrals", value: "289", icon: Globe, change: "+23%" },
  { label: "Cookie Leads", value: "56", icon: Cookie, change: "+15%" },
]

// ─── Admin Dashboard ────────────────────────────────────────────────
export default function AdminPage() {
  const router = useRouter()

  return (
    <div className="container mx-auto px-4 py-6">
      {/* Welcome */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Welcome back 👋</h2>
        <p className="mt-1 text-muted-foreground">
          Your AI-powered travel business command center.
        </p>
      </div>

      {/* Quick Stats */}
      <div className="mb-6 grid gap-4 grid-cols-2 lg:grid-cols-4">
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
              <span className="ml-auto whitespace-nowrap rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                {stat.change}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Traffic Chart — full width, above the fold */}
      <div className="mb-8">
        <TrafficChart />
      </div>

      {/* Feature Grid */}
      <div className="mb-4">
        <h3 className="text-lg font-semibold">Admin Tools</h3>
        <p className="text-sm text-muted-foreground">Select a tool to get started. Features will be activated as we build them together.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {adminTools.map((tool) => (
          <Card
            key={tool.title}
            className={`group relative overflow-hidden transition-shadow hover:shadow-lg ${tool.href ? "cursor-pointer" : ""}`}
            onClick={() => {
              if (!tool.href) return
              if (tool.external) window.open(tool.href, "_blank", "noopener,noreferrer")
              else router.push(tool.href)
            }}
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
