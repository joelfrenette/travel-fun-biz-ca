"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ExternalLink, AlertTriangle } from "lucide-react"

interface Account { platform: string; username?: string; status?: string }
interface Profile { username: string; accounts: Account[] }

interface Posting {
  provider: "upload-post" | "ghl"
  ghl: { configured: boolean; missing: string[]; accounts: { id: string; platform: string; name: string; type?: string; active: boolean; expired: boolean }[]; selected: { id: string; platform: string; name: string }[]; error: string | null }
  configured: boolean
  profiles: Profile[]
  profilesError: string | null
  selectedProfile: string
  selectedPlatforms: string[]
  mode: "review" | "auto" | "off"
  tailoredCaptions: boolean
  aiConfigured: boolean
  dashboardUrl: string
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }
}

const MODES: { value: Posting["mode"]; label: string; hint: string }[] = [
  { value: "review", label: "Review each post first", hint: "Posts wait for your OK on the Post Distribution page. Carousels and videos are made but not posted." },
  { value: "auto", label: "Post automatically", hint: "Blog posts, carousels and videos post by themselves." },
  { value: "off", label: "Don't post", hint: "Content is still written, but nothing goes to social." },
]

export function PostingCard({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<Posting | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  function load() {
    fetch("/api/admin/posting", { headers: authHeaders() })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error || "Could not load")
        setData(body)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
  }
  useEffect(load, [])

  async function save(payload: Record<string, unknown>, okTitle: string) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/posting", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      toast({ title: okTitle })
      load()
      onChanged?.()
    } catch (e) {
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not save", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  // Open a blank tab inside the click so pop-up blockers allow it, then point it at the connect page.
  async function connect() {
    const tab = window.open("", "_blank")
    setBusy(true)
    try {
      const res = await fetch("/api/admin/posting", { method: "POST", headers: authHeaders(), body: JSON.stringify({ action: "connect-link", profile: data?.selectedProfile }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      if (tab) tab.location.href = body.url
      else window.location.href = body.url
      toast({ title: body.direct ? "Opened the connect page" : "Opened Upload-Post", description: body.direct ? "Connect your accounts there, then come back and press Refresh." : "Add or connect accounts there, then come back and press Refresh." })
    } catch (e) {
      tab?.close()
      toast({ title: "Error", description: e instanceof Error ? e.message : "Could not open the connect page", variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Card><CardContent className="p-4 text-sm text-destructive">{error}</CardContent></Card>
  if (!data) return <Card><CardContent className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>

  const profile = data.profiles.find((p) => p.username === data.selectedProfile)
  const savedProfileMissing = !!data.selectedProfile && !profile && data.profiles.length > 0

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Where it posts</h2>
          <div className="flex items-center gap-2 text-xs" role="group" aria-label="Posting provider">
            <Button size="sm" variant={data.provider === "upload-post" ? "default" : "outline"} disabled={busy} onClick={() => data.provider !== "upload-post" && save({ provider: "upload-post" }, "Posting through Upload-Post")}>Upload-Post</Button>
            <Button size="sm" variant={data.provider === "ghl" ? "default" : "outline"} disabled={busy} onClick={() => data.provider !== "ghl" && save({ provider: "ghl" }, "Posting through GoHighLevel")}>GoHighLevel</Button>
          </div>
        </div>

        {data.provider === "ghl" ? (
          <div className="space-y-3">
            {data.ghl.missing.length > 0 ? (
              <p className="flex gap-2 text-sm text-muted-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />GoHighLevel posting needs {data.ghl.missing.join(", ")} in Vercel. The token must be a Private Integration Token with the Social Planner permission (the older API key cannot post).</p>
            ) : (
              <>
                {data.ghl.error && <p className="text-sm text-destructive">{data.ghl.error}</p>}
                <p className="text-sm font-medium">Post to (nothing is ticked until you choose)</p>
                <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                  {data.ghl.accounts.map((a) => {
                    const checked = data.ghl.selected.some((x) => x.id === a.id)
                    const unusable = !a.active || a.expired
                    return (
                      <label key={a.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || unusable}
                          onChange={() => save({ ghlAccounts: checked ? data.ghl.selected.filter((x) => x.id !== a.id) : [...data.ghl.selected, { id: a.id, platform: a.platform, name: a.name }] }, "Saved")}
                        />
                        <span className="capitalize">{a.platform}</span>
                        <span className="truncate text-xs text-muted-foreground">{a.name}</span>
                        {unusable && <Badge variant="destructive">{a.expired ? "expired" : "inactive"}</Badge>}
                      </label>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">Your GoHighLevel holds accounts for several businesses, so tick only the TravelFunBiz ones. The first post through GoHighLevel is an untested path: check the result in GoHighLevel after it goes out.</p>
                <Button size="sm" variant="ghost" disabled={busy} onClick={load}>Refresh</Button>
              </>
            )}
          </div>
        ) : (
          <>
        {!data.configured ? (
          <p className="flex gap-2 text-sm text-muted-foreground"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />UPLOAD_POST_API_KEY is not set in Vercel yet, so there is nothing to connect to.</p>
        ) : (
          <>
            {data.profilesError && <p className="text-sm text-destructive">{data.profilesError}</p>}

            <div className="space-y-1.5">
              <label htmlFor="posting-profile" className="text-sm font-medium">Profile</label>
              {data.profiles.length > 0 ? (
                <select
                  id="posting-profile"
                  className="h-9 w-full max-w-xs rounded-md border bg-card px-3 text-sm"
                  value={data.selectedProfile}
                  disabled={busy}
                  onChange={(e) => save({ profile: e.target.value }, "Profile saved")}
                >
                  <option value="">Choose a profile...</option>
                  {data.profiles.map((p) => <option key={p.username} value={p.username}>{p.username}</option>)}
                </select>
              ) : (
                <p className="text-sm text-muted-foreground">No profiles found yet. Press "Connect accounts" to create one on Upload-Post, then Refresh.</p>
              )}
              {savedProfileMissing && <p className="text-xs text-destructive">The saved profile "{data.selectedProfile}" is not in your Upload-Post list.</p>}
            </div>

            {profile && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Post to</p>
                {profile.accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No accounts connected to this profile yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {profile.accounts.map((a) => {
                      const key = a.platform.toLowerCase()
                      const checked = data.selectedPlatforms.includes(key)
                      return (
                        <label key={a.platform} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy || a.status === "needs reconnect"}
                            onChange={() => save({ platforms: checked ? data.selectedPlatforms.filter((p) => p !== key) : [...data.selectedPlatforms, key] }, "Saved")}
                          />
                          <span className="capitalize">{a.platform}</span>
                          {a.username && <span className="text-xs text-muted-foreground">@{a.username}</span>}
                          {a.status === "needs reconnect" && <Badge variant="destructive">needs reconnect</Badge>}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={connect}><ExternalLink className="mr-1.5 h-3.5 w-3.5" />Connect accounts</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={load}>Refresh</Button>
            </div>
          </>
        )}

          </>
        )}

        <fieldset className="space-y-2 border-t pt-4">
          <legend className="sr-only">Posting mode</legend>
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="posting-mode" className="mt-1" checked={data.mode === m.value} disabled={busy} onChange={() => save({ mode: m.value }, "Saved")} />
              <span><span className="font-medium">{m.label}</span><span className="block text-xs text-muted-foreground">{m.hint}</span></span>
            </label>
          ))}
        </fieldset>

        <label className="flex items-start gap-2 border-t pt-4 text-sm">
          <input type="checkbox" className="mt-1" checked={data.tailoredCaptions} disabled={busy || !data.aiConfigured} onChange={(e) => save({ tailoredCaptions: e.target.checked }, "Saved")} />
          <span><span className="font-medium">Write a different caption for each network</span><span className="block text-xs text-muted-foreground">Costs a little more AI and uses more of your Upload-Post upload quota (one upload per network).</span></span>
        </label>
      </CardContent>
    </Card>
  )
}
