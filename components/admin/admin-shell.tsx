"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { LogOut, ExternalLink, Menu, X, ChevronDown, ChevronRight, CalendarCheck, FileText, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { adminNavGroups, adminNavTop } from "@/lib/admin-nav"
import { COUNT_EVENT, fetchToday, readCachedCount } from "@/components/admin/today-client"

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
      setError("Network error, please try again")
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

// ─── Left-hand nav: Today first, then a few short groups ───────────────────
const OPEN_KEY = "adminNavOpen"

function readOpenState(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}")
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function pathOf(href: string): string {
  return href.split("#")[0].split("?")[0]
}

// An item is "here" when its path matches (or is a parent of the current page). Items that carry a query
// (Blog Auto-Writer is /admin/blog?tab=autoblog) only count when that query is in the address too.
function isHere(href: string, pathname: string, search: string): boolean {
  const base = pathOf(href)
  const query = href.includes("?") ? href.slice(href.indexOf("?")) : ""
  if (href.includes("#")) return false
  if (query) return pathname === base && search.includes(query.slice(1))
  if (base === "/admin") return pathname === "/admin"
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return false
  // Plain Blog is not "here" while the Auto-Writer tab (a separate entry) is open.
  if (base === "/admin/blog" && search.includes("tab=autoblog")) return false
  return true
}

function CountBadge({ count }: { count: number | null }) {
  if (count === null || count <= 0) return null
  return (
    <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold leading-none text-primary-foreground" aria-label={`${count} waiting`}>
      {count > 99 ? "99+" : count}
    </span>
  )
}

function SidebarNav({ onNavigate, todayCount }: { onNavigate?: () => void; todayCount: number | null }) {
  const pathname = usePathname() || ""
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setSearch(window.location.search)
    setOpen(readOpenState())
  }, [pathname])

  function toggle(id: string, now: boolean) {
    const next = { ...open, [id]: !now }
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next))
    } catch {
      // storage can be blocked; the menu still works, it just forgets next time
    }
  }

  const linkClass = (active: boolean) =>
    cn(
      "flex min-h-10 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
      active ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-muted hover:text-foreground",
    )

  return (
    <nav aria-label="Admin" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      {adminNavTop.map((item) => {
        const active = item.title === "Today" ? pathname === "/admin" : false
        return (
          <Link key={item.title} href={item.href!} onClick={onNavigate} aria-current={active ? "page" : undefined} className={linkClass(active)}>
            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.title}</span>
            {item.title === "Today" && <CountBadge count={todayCount} />}
          </Link>
        )
      })}

      {adminNavGroups.map((group) => {
        const hasActive = group.items.some((i) => i.href && isHere(i.href, pathname, search))
        const isOpen = open[group.id] ?? (group.defaultOpen || hasActive)
        const panelId = `nav-group-${group.id}`
        return (
          <div key={group.id} className="mt-2">
            <button
              type="button"
              onClick={() => toggle(group.id, isOpen)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className="flex min-h-9 w-full items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {group.title}
              {!isOpen && hasActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-label="You are in this group" />}
            </button>
            <div id={panelId} hidden={!isOpen} className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                if (!item.href) {
                  return (
                    <div key={item.title} title="Coming soon" className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/60">
                      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.title}</span>
                      <span className="sr-only">(coming soon)</span>
                    </div>
                  )
                }
                const active = isHere(item.href, pathname, search)
                return (
                  <Link key={item.title} href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(linkClass(active), (item as { nested?: boolean }).nested && "ml-4")}>
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.title}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

// ─── Admin Shell: auth gate + persistent left sidebar ───────────────
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<"loading" | "login" | "ready">("loading")
  const [email, setEmail] = useState("")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [todayCount, setTodayCount] = useState<number | null>(null)
  const pathname = usePathname() || ""

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
          setState("ready")
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

  // The Today badge: the last known count straight away, then the live one. The Today page loads the queue itself,
  // so on that page the menu just listens; everywhere else it asks once, a moment after the page is up.
  useEffect(() => {
    if (state !== "ready") return
    setTodayCount(readCachedCount())
    const onCount = (e: Event) => setTodayCount(Number((e as CustomEvent).detail))
    window.addEventListener(COUNT_EVENT, onCount)
    let timer: ReturnType<typeof setTimeout> | undefined
    if (window.location.pathname !== "/admin") timer = setTimeout(() => void fetchToday().catch(() => undefined), 1500)
    return () => {
      window.removeEventListener(COUNT_EVENT, onCount)
      if (timer) clearTimeout(timer)
    }
  }, [state])

  // The phone drawer closes when the page changes, and on Escape.
  useEffect(() => setMobileNavOpen(false), [pathname])
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileNavOpen(false)
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [mobileNavOpen])

  function handleLogin(_token: string, loginEmail: string) {
    setEmail(loginEmail)
    setState("ready")
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
    router.push("/admin")
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

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-card/50 md:flex">
        <div className="border-b px-4 py-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">TravelFunBiz</p>
          <h1 className="text-lg font-bold">Admin</h1>
        </div>
        <SidebarNav todayCount={todayCount} />
        <div className="border-t p-3">
          <p className="truncate px-3 text-xs text-muted-foreground">{email}</p>
        </div>
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label="Admin menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative flex w-72 max-w-[85vw] flex-col border-r bg-card">
            <div className="flex items-center justify-between border-b px-4 py-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">TravelFunBiz</p>
                <h1 className="text-lg font-bold">Admin</h1>
              </div>
              <Button variant="ghost" size="icon" aria-label="Close menu" onClick={() => setMobileNavOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SidebarNav todayCount={todayCount} onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-card/50 px-4 py-3">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <span className="hidden text-sm text-muted-foreground md:inline">{email}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="/" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1 h-3 w-3" />
                View Site
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-1 h-3 w-3" />
              Sign Out
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 pb-20 md:pb-0">{children}</main>
      </div>
      {/* Phone bottom bar: Today first, then the two most used places and the full menu. */}
      <nav aria-label="Quick links" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t bg-card md:hidden">
        <Link href="/admin" aria-current={pathname === "/admin" ? "page" : undefined} className={cn("relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium", pathname === "/admin" ? "text-primary" : "text-foreground/70")}>
          <CalendarCheck className="h-5 w-5" aria-hidden="true" />
          Today
          {todayCount !== null && todayCount > 0 && <span className="absolute right-[22%] top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground" aria-label={`${todayCount} waiting`}>{todayCount > 99 ? "99+" : todayCount}</span>}
        </Link>
        <Link href="/admin/blog" aria-current={pathname.startsWith("/admin/blog") ? "page" : undefined} className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium", pathname.startsWith("/admin/blog") ? "text-primary" : "text-foreground/70")}>
          <FileText className="h-5 w-5" aria-hidden="true" />
          Posts
        </Link>
        <Link href="/admin/leads" aria-current={pathname.startsWith("/admin/leads") ? "page" : undefined} className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium", pathname.startsWith("/admin/leads") ? "text-primary" : "text-foreground/70")}>
          <Users className="h-5 w-5" aria-hidden="true" />
          Leads
        </Link>
        <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open the full menu" className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-foreground/70">
          <Menu className="h-5 w-5" aria-hidden="true" />
          Menu
        </button>
      </nav>
    </div>
  )
}
