"use client"

import { useState, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
  Search, FileText, Globe, TrendingUp, Link2, Image,
  Newspaper, MessageSquare, BarChart3, Package, Bot, Settings,
  LogOut, ExternalLink, Cookie, Users
} from "lucide-react"
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from "recharts"

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

// ─── Admin Login Form ───────────────────────────────────────────────
function LoginView({ onLogin }: { onLogin: (token: string, email: string) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Login failed")
        return
      }

      localStorage.setItem("adminToken", data.token)
      localStorage.setItem("adminEmail", email)
      onLogin(data.token, email)
    } catch {
      setError("Network error — please try again")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Admin Sign In</CardTitle>
          <CardDescription>TravelFunBiz Control Center</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in…" : "Sign In"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
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

// ─── Feature cards for the dashboard ────────────────────────────────
const features = [
  {
    title: "Affiliate Code Manager",
    description: "Set affiliate codes and auto-convert keywords to affiliate hyperlinks across the site.",
    icon: Link2,
    status: "Coming Soon",
  },
  {
    title: "AI Voice & Chat Agent",
    description: "Manage travel info and Q&A files for the AI voice agent and chat agent.",
    icon: Bot,
    status: "Coming Soon",
  },
  {
    title: "Blog Auto-Writer",
    description: "Auto-generate and publish blog articles from trends, news, emails, and curated content.",
    icon: FileText,
    status: "Coming Soon",
  },
  {
    title: "Branchup Email Importer",
    description: "Auto-post Branchup.com email content and promotions to the blog.",
    icon: BarChart3,
    status: "Coming Soon",
  },
  {
    title: "Cookie Lead Collector",
    description: "Auto-collect visitor names, emails, phone numbers, and referrer info via a cookie consent banner on the main site.",
    icon: Cookie,
    status: "Coming Soon",
  },
  {
    title: "Google Trends & Analytics",
    description: "Pull trending keywords and analytics data to auto-generate optimized blog posts.",
    icon: TrendingUp,
    status: "Coming Soon",
  },
  {
    title: "Image & Meta Bulk Editor",
    description: "Bulk update all image alt tags, meta tags, OG descriptions, and OG images site-wide.",
    icon: Image,
    status: "Coming Soon",
  },
  {
    title: "Quora & Reddit Scraper",
    description: "Scrape, post, and answer travel questions on Quora and Reddit to drive traffic.",
    icon: MessageSquare,
    status: "Coming Soon",
  },
  {
    title: "Search Engine Submission",
    description: "Ping new pages, submit sitemaps, manage backlinks, and trigger crawls on Google & Bing.",
    icon: Search,
    status: "Coming Soon",
  },
  {
    title: "SEO & GEO Manager",
    description: "Mass update alt tags, meta descriptions, OG images, robots.txt, AI.txt, and submit to search engines.",
    icon: Globe,
    status: "Coming Soon",
  },
  {
    title: "Site Settings",
    description: "Manage site-wide settings, navigation, footer content, and general configuration.",
    icon: Settings,
    status: "Coming Soon",
  },
  {
    title: "Travel News Auto-Poster",
    description: "Automatically post the latest travel news, events, and industry updates to the blog.",
    icon: Newspaper,
    status: "Coming Soon",
  },
  {
    title: "Travel Package Builder",
    description: "AI-powered tool to research, scrape, and auto-create travel package pages with booking links and info cards.",
    icon: Package,
    status: "Coming Soon",
  },
].sort((a, b) => a.title.localeCompare(b.title))

// ─── Quick Stats Row ────────────────────────────────────────────────
const quickStats = [
  { label: "Total Visitors (14d)", value: "1,247", icon: Users, change: "+12%" },
  { label: "Google Clicks", value: "902", icon: Search, change: "+8%" },
  { label: "Social Referrals", value: "289", icon: Globe, change: "+23%" },
  { label: "Cookie Leads", value: "56", icon: Cookie, change: "+15%" },
]

// ─── Admin Dashboard ────────────────────────────────────────────────
function DashboardView({ email, onLogout }: { email: string; onLogout: () => void }) {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">TravelFunBiz</p>
            <h1 className="text-xl font-bold">Admin Control Center</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
            <Button variant="outline" size="sm" asChild>
              <a href="/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1 h-3 w-3" />
                View Site
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut className="mr-1 h-3 w-3" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {/* Welcome */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold">Welcome back, Joel 👋</h2>
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
          {features.map((feature) => (
            <Card key={feature.title} className="group relative overflow-hidden transition-shadow hover:shadow-lg">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {feature.status}
                  </span>
                </div>
                <CardTitle className="mt-3 text-base">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  )
}

// ─── Main Admin Page (handles auth state) ───────────────────────────
export default function AdminPage() {
  const [state, setState] = useState<"loading" | "login" | "dashboard">("loading")
  const [email, setEmail] = useState("")

  useEffect(() => {
    async function checkAuth() {
      const token = localStorage.getItem("adminToken")
      const storedEmail = localStorage.getItem("adminEmail")

      if (!token) {
        setState("login")
        return
      }

      try {
        const res = await fetch("/api/admin/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })

        const data = await res.json()

        if (data.valid) {
          setEmail(data.email || storedEmail || "admin")
          setState("dashboard")
        } else {
          localStorage.removeItem("adminToken")
          localStorage.removeItem("adminEmail")
          setState("login")
        }
      } catch {
        setState("login")
      }
    }

    checkAuth()
  }, [])

  function handleLogin(token: string, loginEmail: string) {
    setEmail(loginEmail)
    setState("dashboard")
  }

  async function handleLogout() {
    const token = localStorage.getItem("adminToken")
    if (token) {
      await fetch("/api/admin/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }).catch(() => {})
    }
    localStorage.removeItem("adminToken")
    localStorage.removeItem("adminEmail")
    setState("login")
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (state === "login") {
    return <LoginView onLogin={handleLogin} />
  }

  return <DashboardView email={email} onLogout={handleLogout} />
}