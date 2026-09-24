"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { LogOut, ExternalLink, Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { adminNavItems } from "@/lib/admin-nav"

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

// ─── Left-hand nav (GoHighLevel-style) ───────────────────────────────
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      {adminNavItems.map((item) => {
        const isActive = item.href === pathname
        const isDisabled = !item.href

        if (isDisabled) {
          return (
            <div
              key={item.title}
              title="Coming soon"
              className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.title}</span>
            </div>
          )
        }

        const className = cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-foreground/80 hover:bg-muted hover:text-foreground",
        )

        if (item.external) {
          return (
            <a key={item.title} href={item.href!} target="_blank" rel="noopener noreferrer" onClick={onNavigate} className={className}>
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.title}</span>
              <ExternalLink className="ml-auto h-3 w-3 shrink-0 opacity-50" />
            </a>
          )
        }

        return (
          <Link key={item.title} href={item.href!} onClick={onNavigate} className={className}>
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.title}</span>
          </Link>
        )
      })}
    </nav>
  )
}

// ─── Admin Shell — auth gate + persistent left sidebar ───────────────
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<"loading" | "login" | "ready">("loading")
  const [email, setEmail] = useState("")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

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
        <SidebarNav />
        <div className="border-t p-3">
          <p className="truncate px-3 text-xs text-muted-foreground">{email}</p>
        </div>
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative flex w-64 flex-col border-r bg-card">
            <div className="flex items-center justify-between border-b px-4 py-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">TravelFunBiz</p>
                <h1 className="text-lg font-bold">Admin</h1>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SidebarNav onNavigate={() => setMobileNavOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-card/50 px-4 py-3">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileNavOpen(true)}>
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
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
