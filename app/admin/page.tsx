"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
  Search, FileText, Globe, TrendingUp, Link2, Image,
  Newspaper, MessageSquare, BarChart3, Package, Bot, Settings,
  LogOut, ExternalLink
} from "lucide-react"

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

      // Store token in localStorage and notify parent
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

// ─── Feature cards for the dashboard ────────────────────────────────
const features = [
  {
    title: "Travel Package Builder",
    description: "AI-powered tool to research, scrape, and auto-create travel package pages with booking links and info cards.",
    icon: Package,
    status: "Coming Soon",
  },
  {
    title: "Blog Auto-Writer",
    description: "Auto-generate and publish blog articles from trends, news, emails, and curated content.",
    icon: FileText,
    status: "Coming Soon",
  },
  {
    title: "SEO & GEO Manager",
    description: "Mass update alt tags, meta descriptions, OG images, robots.txt, AI.txt, and submit to search engines.",
    icon: Globe,
    status: "Coming Soon",
  },
  {
    title: "Google Trends & Analytics",
    description: "Pull trending keywords and analytics data to auto-generate optimized blog posts.",
    icon: TrendingUp,
    status: "Coming Soon",
  },
  {
    title: "Affiliate Code Manager",
    description: "Set affiliate codes and auto-convert keywords to affiliate hyperlinks across the site.",
    icon: Link2,
    status: "Coming Soon",
  },
  {
    title: "Image & Meta Bulk Editor",
    description: "Bulk update all image alt tags, meta tags, OG descriptions, and OG images site-wide.",
    icon: Image,
    status: "Coming Soon",
  },
  {
    title: "Travel News Auto-Poster",
    description: "Automatically post the latest travel news, events, and industry updates to the blog.",
    icon: Newspaper,
    status: "Coming Soon",
  },
  {
    title: "Quora & Reddit Scraper",
    description: "Scrape, post, and answer travel questions on Quora and Reddit to drive traffic.",
    icon: MessageSquare,
    status: "Coming Soon",
  },
  {
    title: "Branchup Email Importer",
    description: "Auto-post Branchup.com email content and promotions to the blog.",
    icon: BarChart3,
    status: "Coming Soon",
  },
  {
    title: "AI Voice & Chat Agent",
    description: "Manage travel info and Q&A files for the AI voice agent and chat agent.",
    icon: Bot,
    status: "Coming Soon",
  },
  {
    title: "Search Engine Submission",
    description: "Ping new pages, submit sitemaps, manage backlinks, and trigger crawls on Google & Bing.",
    icon: Search,
    status: "Coming Soon",
  },
  {
    title: "Site Settings",
    description: "Manage site-wide settings, navigation, footer content, and general configuration.",
    icon: Settings,
    status: "Coming Soon",
  },
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

      {/* Welcome */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold">Welcome back, Joel 👋</h2>
          <p className="mt-1 text-muted-foreground">
            Your AI-powered travel business command center. Select a tool below to get started.
          </p>
        </div>

        {/* Feature Grid */}
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
  const router = useRouter()

  // On mount, check if we have a stored token and verify it
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
          // Token expired or invalid — clear and show login
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
