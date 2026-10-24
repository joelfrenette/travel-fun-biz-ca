"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { agentsCall, agentsHeaders, arr, s, type Row } from "@/components/admin/agents-api"
import { ACHIEVEMENT_KINDS, publishBlockers } from "@/lib/agents"

interface Cert { name: string; issuer: string; year: string; verified: boolean }

function certsOf(v: unknown): Cert[] {
  return Array.isArray(v) ? (v as Row[]).map((c) => ({ name: s(c.name), issuer: s(c.issuer), year: c.year == null ? "" : s(c.year), verified: c.verified === true })) : []
}

export function AgentsEditor({ agent, achievements, onClose, onChanged }: { agent: Row | null; achievements: Row[]; onClose: () => void; onChanged: () => void }) {
  const [id, setId] = useState<string | null>(agent ? s(agent.id) : null)
  const [name, setName] = useState(s(agent?.display_name))
  const [slug, setSlug] = useState(s(agent?.slug))
  const [headline, setHeadline] = useState(s(agent?.headline))
  const [bio, setBio] = useState(s(agent?.bio))
  const [specialties, setSpecialties] = useState(arr(agent?.specialties).join(", "))
  const [languages, setLanguages] = useState(arr(agent?.languages).join(", "))
  const [years, setYears] = useState(agent?.years_experience == null ? "" : s(agent.years_experience))
  const [city, setCity] = useState(s(agent?.home_city))
  const [region, setRegion] = useState(s(agent?.region))
  const [photo, setPhoto] = useState(s(agent?.photo_url))
  const [videos, setVideos] = useState(arr(agent?.video_urls).join("\n"))
  const [certs, setCerts] = useState<Cert[]>(certsOf(agent?.certifications))
  const [cPhoto, setCPhoto] = useState(agent?.consent_photo === true)
  const [cBio, setCBio] = useState(agent?.consent_bio === true)
  const [featured, setFeatured] = useState(agent?.featured === true)
  const [sort, setSort] = useState(agent?.sort_order == null ? "100" : s(agent.sort_order))
  const [email, setEmail] = useState(s(agent?.email))
  const [phone, setPhone] = useState(s(agent?.phone))
  const [notes, setNotes] = useState(s(agent?.notes))
  const [status, setStatus] = useState(s(agent?.status) || "draft")
  const [msg, setMsg] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [polished, setPolished] = useState("")
  const [link, setLink] = useState("")
  const [ach, setAch] = useState<Row[]>(achievements)
  const [na, setNa] = useState({ kind: "other", title: "", period: "", public: false, internal_value: "" })

  const blockers = publishBlockers({ display_name: name, slug: slug || "x", bio, specialties: specialties.split(",").map((x) => x.trim()).filter(Boolean), consent_photo: cPhoto, consent_bio: cBio })

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true); setErr(""); setMsg("")
    try { const r = await fn(); if (ok) setMsg(ok); return r } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); return undefined } finally { setBusy(false) }
  }

  const payload = () => ({
    display_name: name, slug: slug || undefined, headline, bio, specialties, languages, years_experience: years, home_city: city, region, photo_url: photo,
    video_urls: videos, certifications: certs.map((c) => ({ ...c, year: c.year ? Number(c.year) : null })), consent_photo: cPhoto, consent_bio: cBio, featured,
    sort_order: sort, email, phone, notes,
  })

  async function save() {
    const r = await run(() => agentsCall<{ agent: Row }>({ action: "save", id, agent: payload() }), "Saved.")
    if (r) { setId(s(r.agent.id)); setSlug(s(r.agent.slug)); setStatus(s(r.agent.status)); onChanged() }
  }
  async function setStatusTo(next: "draft" | "ready" | "published") {
    if (!id) { setErr("Save the agent first."); return }
    const r = await run(() => agentsCall<{ queued: string[] }>({ action: "status", id, status: next }))
    if (r) { setStatus(next); setMsg(next === "published" ? `Published.${r.queued.length ? " Draft content was queued for your approval (Review tab)." : ""}` : "Updated."); onChanged() }
  }
  async function upload(file: File) {
    setBusy(true); setErr("")
    try {
      const fd = new FormData(); fd.append("file", file)
      const res = await fetch("/api/admin/upload-image", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("adminToken") || ""}` }, body: fd })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setPhoto(d.url)
    } catch (e) { setErr(e instanceof Error ? e.message : "Upload failed") } finally { setBusy(false) }
  }
  async function makeLink() {
    if (!id) { setErr("Save the agent first."); return }
    const r = await run(() => agentsCall<{ path: string; expires_at: string }>({ action: "link", id }))
    if (r) setLink(`${window.location.origin}${r.path}   (expires ${new Date(r.expires_at).toLocaleDateString()}; shown once, copy it now)`)
  }
  async function polish() {
    if (!id) { setErr("Save the agent first."); return }
    const r = await run(() => agentsCall<{ text: string; cached: boolean }>({ action: "polish", id, text: bio }))
    if (r) setPolished(r.text)
  }
  async function remove() {
    if (!id || !confirm(`Delete ${name} and their milestones? This cannot be undone.`)) return
    const r = await run(() => agentsCall({ action: "delete", id }))
    if (r) { onChanged(); onClose() }
  }
  async function addAch() {
    if (!id) { setErr("Save the agent first."); return }
    const r = await run(() => agentsCall<{ achievement: Row }>({ action: "achievement", achievement: { ...na, agent_id: id } }), "Milestone added.")
    if (r) { setAch([r.achievement, ...ach]); setNa({ kind: "other", title: "", period: "", public: false, internal_value: "" }); onChanged() }
  }
  async function togglePublic(a: Row) {
    const r = await run(() => agentsCall<{ achievement: Row }>({ action: "achievement", achievement: { ...a, public: a.public !== true } }))
    if (r) { setAch(ach.map((x) => (x.id === a.id ? r.achievement : x))); onChanged() }
  }
  async function delAch(a: Row) {
    const r = await run(() => agentsCall({ action: "achievement-delete", id: s(a.id) }))
    if (r) { setAch(ach.filter((x) => x.id !== a.id)); onChanged() }
  }

  const field = "space-y-1"
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{id ? `Edit ${name}` : "New agent"} <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal">{status}</span></h2>
        <Button variant="outline" size="sm" onClick={onClose}>Back to roster</Button>
      </div>
      {err && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{err}</p>}
      {msg && <p role="status" className="rounded-md border bg-muted/40 p-2 text-sm">{msg}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div className={field}><Label htmlFor="ag-name">Display name</Label><Input id="ag-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className={field}><Label htmlFor="ag-slug">Web address (leave empty to make one)</Label><Input id="ag-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="jane-doe" /></div>
        <div className={`${field} md:col-span-2`}><Label htmlFor="ag-head">Headline</Label><Input id="ag-head" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Group trips and cruises for solo travellers" /></div>
        <div className={`${field} md:col-span-2`}>
          <Label htmlFor="ag-bio">Bio (the agent&apos;s own words)</Label>
          <Textarea id="ag-bio" rows={6} value={bio} onChange={(e) => setBio(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={polish}>Polish my bio (AI, rewrites only this text)</Button>
            <span className="text-xs text-muted-foreground">It adds no facts, numbers, names or certifications, and a rewrite that does is thrown away.</span>
          </div>
          {polished && (
            <div className="rounded-md border p-3 text-sm">
              <p className="whitespace-pre-wrap">{polished}</p>
              <Button type="button" size="sm" className="mt-2" onClick={() => { setBio(polished); setPolished("") }}>Use this version</Button>
              <Button type="button" size="sm" variant="ghost" className="ml-2" onClick={() => setPolished("")}>Dismiss</Button>
            </div>
          )}
        </div>
        <div className={field}><Label htmlFor="ag-spec">Specialties (comma separated)</Label><Input id="ag-spec" value={specialties} onChange={(e) => setSpecialties(e.target.value)} placeholder="Caribbean cruises, Italy, Solo travel" /></div>
        <div className={field}><Label htmlFor="ag-lang">Languages</Label><Input id="ag-lang" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="English, French" /></div>
        <div className={field}><Label htmlFor="ag-years">Years of experience</Label><Input id="ag-years" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} /></div>
        <div className={field}><Label htmlFor="ag-city">Home city</Label><Input id="ag-city" value={city} onChange={(e) => setCity(e.target.value)} /></div>
        <div className={field}><Label htmlFor="ag-region">Region</Label><Input id="ag-region" value={region} onChange={(e) => setRegion(e.target.value)} /></div>
        <div className={field}><Label htmlFor="ag-sort">Sort order (lower first)</Label><Input id="ag-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} /></div>
        <div className={`${field} md:col-span-2`}>
          <Label htmlFor="ag-photo">Photo link (https), or upload one</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="ag-photo" className="max-w-md" value={photo} onChange={(e) => setPhoto(e.target.value)} />
            <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload a photo" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          </div>
          {photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={photo} alt={`Preview of ${name}`} className="mt-2 h-24 w-24 rounded-md object-cover" />}
        </div>
        <div className={`${field} md:col-span-2`}><Label htmlFor="ag-vid">Testimonial video links (YouTube or Vimeo, one per line, up to 3)</Label><Textarea id="ag-vid" rows={2} value={videos} onChange={(e) => setVideos(e.target.value)} /></div>
      </div>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Certifications (shown publicly ONLY when Verified is ticked)</legend>
        {certs.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="w-52" aria-label="Certification name" placeholder="Name" value={c.name} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Input className="w-44" aria-label="Issuer" placeholder="Issued by" value={c.issuer} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, issuer: e.target.value } : x)))} />
            <Input className="w-20" aria-label="Year" placeholder="Year" value={c.year} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, year: e.target.value } : x)))} />
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={c.verified} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, verified: e.target.checked } : x)))} /> I checked it: Verified</label>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCerts(certs.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => setCerts([...certs, { name: "", issuer: "", year: "", verified: false }])}>Add a certification</Button>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Consent and visibility</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cPhoto} onChange={(e) => setCPhoto(e.target.checked)} /> The agent agreed to show their photo publicly</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cBio} onChange={(e) => setCBio(e.target.checked)} /> The agent agreed to show their bio publicly</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} /> Featured (shown on the home page)</label>
      </fieldset>

      <fieldset className="grid gap-3 rounded-md border bg-muted/30 p-3 md:grid-cols-3">
        <legend className="px-1 text-sm font-medium">Private. Never shown on the site.</legend>
        <div className={field}><Label htmlFor="ag-email">Email</Label><Input id="ag-email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className={field}><Label htmlFor="ag-phone">Phone</Label><Input id="ag-phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div className={`${field} md:col-span-3`}><Label htmlFor="ag-notes">Notes</Label><Textarea id="ag-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={save}>Save</Button>
        {status !== "ready" && status !== "published" && <Button disabled={busy} variant="outline" onClick={() => setStatusTo("ready")}>Mark ready</Button>}
        {status !== "published" && <Button disabled={busy || blockers.length > 0} variant="outline" onClick={() => setStatusTo("published")}>Publish</Button>}
        {status === "published" && <Button disabled={busy} variant="outline" onClick={() => setStatusTo("draft")}>Unpublish</Button>}
        <Button disabled={busy} variant="outline" onClick={makeLink}>Send profile link</Button>
        {id && <Button disabled={busy} variant="ghost" onClick={remove}>Delete</Button>}
      </div>
      {status !== "published" && blockers.length > 0 && <p className="text-xs text-muted-foreground">Publish needs: {blockers.join(" ")} (save first after changing anything)</p>}
      {link && <p className="break-all rounded-md border p-2 text-sm">Self-service link for the agent: {link}</p>}

      {id && (
        <fieldset className="space-y-3 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Milestones</legend>
          <p className="text-xs text-muted-foreground">A milestone appears on the public page only when Show publicly is on, and then shows only the title and period. The private value (sales or commission) is never shown on the site.</p>
          {ach.map((a) => (
            <div key={s(a.id)} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{s(a.title)}</span><span className="text-muted-foreground">{s(a.period)}</span>
              <label className="flex items-center gap-1"><input type="checkbox" checked={a.public === true} onChange={() => togglePublic(a)} /> Show publicly</label>
              {a.internal_value != null && <span className="text-xs text-muted-foreground">Private value: {s(a.internal_value)}</span>}
              <Button size="sm" variant="ghost" onClick={() => delAch(a)}>Remove</Button>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2">
            <select className="h-10 rounded-md border bg-background px-2 text-sm" aria-label="Kind" value={na.kind} onChange={(e) => setNa({ ...na, kind: e.target.value })}>
              {Object.entries(ACHIEVEMENT_KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <Input className="w-64" aria-label="Milestone title" placeholder="Title (no amounts)" value={na.title} onChange={(e) => setNa({ ...na, title: e.target.value })} />
            <Input className="w-32" aria-label="Period" placeholder="2026 Q3" value={na.period} onChange={(e) => setNa({ ...na, period: e.target.value })} />
            <Input className="w-36" aria-label="Private value" placeholder="Private value" inputMode="decimal" value={na.internal_value} onChange={(e) => setNa({ ...na, internal_value: e.target.value })} />
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={na.public} onChange={(e) => setNa({ ...na, public: e.target.checked })} /> Show publicly</label>
            <Button size="sm" disabled={busy} onClick={addAch}>Add milestone</Button>
          </div>
        </fieldset>
      )}
    </div>
  )
}
