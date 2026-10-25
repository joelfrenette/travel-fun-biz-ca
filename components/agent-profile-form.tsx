"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface Cert { name: string; issuer: string; year: string }
interface Existing { display_name: string; bio: string | null; headline: string | null; specialties: string[]; years_experience: number | null; languages: string[]; video_urls: string[]; promoted_package_slugs?: string[] }
interface Pkg { slug: string; name: string }

// The self-service profile form behind an agent's private link. They fill their own bio, photo, certifications, years,
// languages, specialties and a testimonial video link. Everything is saved as a PENDING draft: the office approves it before
// anything is public, and certifications are only shown on the site after the office has checked them.
export function AgentProfileForm({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "form" | "done" | "error">("loading")
  const [error, setError] = useState("")
  const [name, setName] = useState("")
  const [bio, setBio] = useState("")
  const [headline, setHeadline] = useState("")
  const [specialties, setSpecialties] = useState("")
  const [languages, setLanguages] = useState("")
  const [years, setYears] = useState("")
  const [video, setVideo] = useState("")
  const [photo, setPhoto] = useState("")
  const [certs, setCerts] = useState<Cert[]>([])
  const [cPhoto, setCPhoto] = useState(false)
  const [cBio, setCBio] = useState(false)
  const [pkgs, setPkgs] = useState<Pkg[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [testimonial, setTestimonial] = useState("")
  const [tripLink, setTripLink] = useState<string | null>(null)
  const [honey, setHoney] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(`/api/agent-profile/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || "This link is not valid.")
        const a = d.agent as Existing
        setName(a.display_name); setBio(a.bio ?? ""); setHeadline(a.headline ?? ""); setSpecialties(a.specialties.join(", "))
        setLanguages(a.languages.join(", ")); setYears(a.years_experience == null ? "" : String(a.years_experience)); setVideo(a.video_urls[0] ?? "")
        setPkgs((d.packages ?? []) as Pkg[]); setPicked(a.promoted_package_slugs ?? []); setTripLink(typeof d.tripLink === "string" ? d.tripLink : null)
        setState("form")
      })
      .catch((e) => { setError(e instanceof Error ? e.message : "This link is not valid."); setState("error") })
  }, [token])

  async function upload(file: File) {
    setBusy(true); setError("")
    try {
      const fd = new FormData(); fd.append("file", file)
      const r = await fetch(`/api/agent-profile/${encodeURIComponent(token)}`, { method: "POST", body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || "The photo could not be saved.")
      setPhoto(d.url)
    } catch (e) { setError(e instanceof Error ? e.message : "The photo could not be saved.") } finally { setBusy(false) }
  }

  async function send() {
    setBusy(true); setError("")
    try {
      const r = await fetch(`/api/agent-profile/${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio, headline, specialties, languages, years_experience: years, video_urls: video ? [video] : [], photo_url: photo, certifications: certs.map((c) => ({ name: c.name, issuer: c.issuer, year: c.year ? Number(c.year) : null })), consent_photo: cPhoto, consent_bio: cBio, promoted_package_slugs: picked, testimonial_text: testimonial, company_website: honey }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || "Could not send. Please try again.")
      setState("done")
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send. Please try again.") } finally { setBusy(false) }
  }

  if (state === "loading") return <main className="container mx-auto max-w-2xl px-4 py-12"><p>Loading...</p></main>
  if (state === "error") return <main className="container mx-auto max-w-2xl px-4 py-12"><h1 className="text-2xl font-bold">This link cannot be used</h1><p className="mt-3 text-muted-foreground">{error}</p></main>
  if (state === "done") return <main className="container mx-auto max-w-2xl px-4 py-12"><h1 className="text-2xl font-bold">Thank you</h1><p className="mt-3 text-muted-foreground">Your profile was sent to the office. Nothing goes on the website until they approve it. You can reopen this link to send changes while it is active.</p></main>

  return (
    <main className="container mx-auto max-w-2xl space-y-5 px-4 py-10">
      <h1 className="text-2xl font-bold">Your travel specialist profile{name ? `, ${name}` : ""}</h1>
      <p className="text-sm text-muted-foreground">Fill in what you want visitors to see. The office reviews it before anything is public. Your phone and email are never shown on the website: visitors reach you through the enquiry form.</p>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}
      <div className="hidden" aria-hidden="true"><input tabIndex={-1} autoComplete="off" name="company_website" value={honey} onChange={(e) => setHoney(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="p-head">Headline (one line)</Label><Input id="p-head" value={headline} maxLength={140} onChange={(e) => setHeadline(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="p-bio">Your bio (a few sentences, in your own words)</Label><Textarea id="p-bio" rows={7} value={bio} onChange={(e) => setBio(e.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="p-spec">Your specialties (separate with commas)</Label><Input id="p-spec" value={specialties} onChange={(e) => setSpecialties(e.target.value)} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="p-years">Years of experience in travel</Label><Input id="p-years" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="p-lang">Languages you speak</Label><Input id="p-lang" value={languages} onChange={(e) => setLanguages(e.target.value)} /></div>
      </div>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Certifications (the office checks each one before it is shown)</legend>
        {certs.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="w-48" aria-label="Certification" placeholder="Certification" value={c.name} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Input className="w-40" aria-label="Issued by" placeholder="Issued by" value={c.issuer} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, issuer: e.target.value } : x)))} />
            <Input className="w-20" aria-label="Year" placeholder="Year" value={c.year} onChange={(e) => setCerts(certs.map((x, j) => (j === i ? { ...x, year: e.target.value } : x)))} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setCerts(certs.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setCerts([...certs, { name: "", issuer: "", year: "" }])}>Add a certification</Button>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="p-photo">Your photo (JPEG, PNG or WebP, up to 3 MB)</Label>
        <input id="p-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
        {photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={photo} alt="Your uploaded photo" className="mt-2 h-24 w-24 rounded-md object-cover" />}
      </div>
      <div className="space-y-1"><Label htmlFor="p-video">Testimonial or intro video link (YouTube or Vimeo, optional)</Label><Input id="p-video" type="url" value={video} onChange={(e) => setVideo(e.target.value)} placeholder="https://" /></div>
      {pkgs.length > 0 && (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Trips you are hosting or promoting (the office confirms the list)</legend>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {pkgs.map((p) => (
              <label key={p.slug} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={picked.includes(p.slug)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.slug].slice(0, 12) : picked.filter((x) => x !== p.slug))} /> {p.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Pick up to 12. These show on your public page with a form so visitors can ask about them. To add a brand new trip, or to share photos and videos from a trip that has finished, ask the office for the trip link.</p>
        </fieldset>
      )}
      {tripLink && (
        <p className="rounded-md border p-3 text-sm">
          Promoting a trip that is not on the list? <a href={tripLink} className="font-medium underline">Add a new trip</a>. The office reviews it, and once it is published it shows on your page.
        </p>
      )}
      <div className="space-y-1"><Label htmlFor="p-test">A short testimonial or message to your travellers (optional, up to 600 characters)</Label><Textarea id="p-test" rows={3} maxLength={600} value={testimonial} onChange={(e) => setTestimonial(e.target.value)} /></div>
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Permission</legend>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={cBio} onChange={(e) => setCBio(e.target.checked)} /> I agree that my name and this bio may be shown publicly on the website.</label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={cPhoto} onChange={(e) => setCPhoto(e.target.checked)} /> I agree that my photo may be shown publicly on the website.</label>
      </fieldset>
      <Button disabled={busy} onClick={send}>Send to the office for review</Button>
    </main>
  )
}
