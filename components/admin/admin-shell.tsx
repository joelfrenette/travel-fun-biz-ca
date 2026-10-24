"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { LogOut, ExternalLink, Menu, X, ChevronDown, ChevronRight, CalendarCheck, ListChecks, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { adminNavSections, type NavBadge, type NumberedNavLink } from "@/lib/admin-nav"
import { BADGES_EVENT, fetchToday, readCachedBadges, type NavBadges } from "@/components/admin/today-client"

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

// ─── Left-hand nav: numbered steps in the order of the day, in short sections ─────────────────────
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
  if (/^https?:/.test(href)) return false
  if (query) return pathname === base && search.includes(query.slice(1))
  if (base === "/admin") return pathname === "/admin"
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return false
  // Plain Blog is not "here" while the Auto-Writer tab (a separate entry) is open.
  if (base === "/admin/blog" && search.includes("tab=autoblog")) return false
  return true
}

const CHECK_DOT: Record<string, string> = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }
const CHECK_WORD: Record<string, string> = { green: "all good", amber: "worth a look", red: "needs you" }

function Badge({ kind, badges }: { kind: NavBadge | undefined; badges: NavBadges }) {
  if (kind === "today" || kind === "followups") {
    const n = kind === "today" ? badges.today : badges.followups
    if (n === null || n <= 0) return null
    return (
      <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold leading-none text-primary-foreground" aria-label={`${n} waiting`}>
        {n > 99 ? "99+" : n}
      </span>
    )
  }
  if (kind === "check" && badges.check) {
    return (
      <span className="ml-auto flex items-center" role="img" aria-label={`System check: ${CHECK_WORD[badges.check]}`}>
        <span className={cn("h-2.5 w-2.5 rounded-full", CHECK_DOT[badges.check])} />
      </span>
    )
  }
  return null
}

function SidebarNav({ onNavigate, badges }: { onNavigate?: () => void; badges: NavBadges }) {
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
      "flex min-h-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
      active ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-muted hover:text-foreground",
    )

  const inner = (link: NumberedNavLink) => (
    <>
      {link.step !== null ? (
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none")} aria-hidden="true">
          {link.step}
        </span>
      ) : (
        <link.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">{link.title}</span>
      {link.step !== null && <span className="sr-only">(step {link.step})</span>}
      {link.external && <ExternalLink className="ml-auto h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
      <Badge kind={link.badge} badges={badges} />
    </>
  )

  return (
    <nav aria-label="Admin" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      {adminNavSections.map((section) => {
        const hasActive = [...section.links, ...(section.later ?? [])].some((l) => !l.shortcut && l.href && isHere(l.href, pathname, search))
        const isOpen = open[section.id] ?? (section.defaultOpen || hasActive)
        const panelId = `nav-section-${section.id}`
        return (
          <div key={section.id} className="mt-1.5">
            <button
              type="button"
              onClick={() => toggle(section.id, isOpen)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              title={section.hint}
              className="flex min-h-9 w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
              {section.title}
              {!isOpen && hasActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-label="You are in this section" />}
            </button>
            <div id={panelId} hidden={!isOpen} className="flex flex-col gap-0.5">
              {section.links.map((link) => {
                if (!link.href) return null
                if (link.external) {
                  return (
                    <a key={link.key} href={link.href} target="_blank" rel="noopener noreferrer" onClick={onNavigate} className={linkClass(false)}>
                      {inner(link)}
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  )
                }
                const active = !link.shortcut && (link.key === "Today" ? pathname === "/admin" : isHere(link.href, pathname, search))
                return (
                  <Link key={link.key} href={link.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(linkClass(active), link.nested && "ml-4")}>
                    {inner(link)}
                  </Link>
                )
              })}
              {section.later && section.later.length > 0 && (
                <div className="mt-1.5">
                  <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Later (not built yet)</p>
                  {section.later.map((item) => (
                    <div key={item.key} title="Coming soon" className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground/60">
                      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.title}</span>
                      <span className="sr-only">(coming soon)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function BottomLink({ href, label, active, icon: Icon, count, light }: { href: string; label: string; active: boolean; icon: typeof CalendarCheck; count?: number | null; light?: string | null }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium", active ? "text-primary" : "text-foreground/70")}>
      <Icon className="h-5 w-5" aria-hidden="true" />
      {label}
      {typeof count === "number" && count > 0 && (
        <span className="absolute right-[18%] top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground" aria-label={`${count} waiting`}>
          {count > 99 ? "99+" : count}
        </span>
      )}
      {light && (
        <span className="absolute right-[28%] top-2" role="img" aria-label={`System check: ${CHECK_WORD[light]}`}>
          <span className={cn("block h-2.5 w-2.5 rounded-full", CHECK_DOT[light])} />
        </span>
      )}
    </Link>
  )
}

// ─── Admin Shell: auth gate + persistent left sidebar ───────────────
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<"loading" | "login" | "ready">("loading")
  const [email, setEmail] = useState("")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [badges, setBadges] = useState<NavBadges>({ today: null, followups: null, check: null })
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

  // The three menu badges (Today cards, open follow-ups, system check light) all come from ONE fetch of the Today queue:
  // the last known numbers straight away, then the live ones. The Today page loads the queue itself, so on that page the
  // menu just listens; the follow-ups and system check pages announce their own fresher numbers. Everywhere else the menu
  // asks once, a moment after the page is up.
  useEffect(() => {
    if (state !== "ready") return
    setBadges(readCachedBadges())
    const onBadges = (e: Event) => setBadges((e as CustomEvent<NavBadges>).detail)
    window.addEventListener(BADGES_EVENT, onBadges)
    let timer: ReturnType<typeof setTimeout> | undefined
    if (window.location.pathname !== "/admin") timer = setTimeout(() => void fetchToday().catch(() => undefined), 1500)
    return () => {
      window.removeEventListener(BADGES_EVENT, onBadges)
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
        <SidebarNav badges={badges} />
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
            <SidebarNav badges={badges} onNavigate={() => setMobileNavOpen(false)} />
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
      {/* Phone bottom bar: the three things to open every day, then the full menu. */}
      <nav aria-label="Quick links" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t bg-card md:hidden">
        <BottomLink href="/admin" label="Today" active={pathname === "/admin"} icon={CalendarCheck} count={badges.today} />
        <BottomLink href="/admin/follow-ups" label="Follow-ups" active={pathname.startsWith("/admin/follow-ups")} icon={ListChecks} count={badges.followups} />
        <BottomLink href="/admin/system-check" label="Check" active={pathname.startsWith("/admin/system-check")} icon={ShieldCheck} light={badges.check} />
        <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open the full menu" className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-foreground/70">
          <Menu className="h-5 w-5" aria-hidden="true" />
          Menu
        </button>
      </nav>
    </div>
  )
}
