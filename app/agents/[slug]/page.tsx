import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ContactForm } from "@/components/contact-form"
import { AgentAvatar } from "@/components/agents-ui"
import { getAgentOfMonth, getPublicAchievements, getPublishedAgent, getPublishedPackagesBySlugs } from "@/lib/agents-store"
import {
  achievementLabel, agentDescription, agentPath, agentPhotoAlt, agentTitle, buildProfilePageJsonLd, buildVideoJsonLd, firstName, monthLabel,
  parseVideoUrl, publicCertifications, socialLabel, specialtyKey,
} from "@/lib/agents"
import { buildBreadcrumbJsonLd, jsonLdHtml } from "@/lib/jsonld"
import { getDestinationSlugs } from "@/lib/destinations"
import { getPublishedGuidePaths, guidePath } from "@/lib/guides"
import { getPackages } from "@/lib/packages"
import { getVisitorPreferences } from "@/lib/preferences"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl, site } from "@/lib/site"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const agent = await getPublishedAgent(params.slug)
  // An unpublished, unconsented or unknown agent is not a page: keep it out of search entirely.
  if (!agent) return { title: `Travel specialist not found | ${SITE_NAME}`, robots: { index: false } }
  const title = agentTitle(agent, SITE_NAME)
  const description = agentDescription(agent)
  const url = absoluteUrl(agentPath(agent.slug))
  const image = agent.photo_url ?? DEFAULT_OG_IMAGE
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "profile", images: [{ url: image, alt: agent.photo_url ? agentPhotoAlt(agent.display_name) : SITE_NAME }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  }
}

export default async function AgentPage({ params }: Props) {
  const { language, currency } = getVisitorPreferences()
  const agent = await getPublishedAgent(params.slug)
  if (!agent) notFound()
  const [achMap, aotm, dests, guides, packages, hosted] = await Promise.all([
    getPublicAchievements([agent.id]),
    getAgentOfMonth(),
    getDestinationSlugs().catch(() => []),
    getPublishedGuidePaths().catch(() => []),
    getPackages().catch(() => []),
    getPublishedPackagesBySlugs(agent.promoted_package_slugs),
  ])
  const achievements = achMap.get(agent.id) ?? []
  const certs = publicCertifications(agent.certifications)
  const videos = agent.video_urls.map((u) => ({ url: u, v: parseVideoUrl(u) })).filter((x) => !!x.v)
  const isAotm = aotm?.agent.id === agent.id

  // A specialty links to a destination or guide page only when one really exists with that slug.
  const destSlugs = new Set(dests.map((d) => d.slug))
  const linkFor = (sp: string): string | null => {
    const key = specialtyKey(sp)
    if (destSlugs.has(key)) return `/destinations/${key}`
    const g = guides.find((x) => x.slug === key)
    return g ? guidePath(g.kind, g.slug) : null
  }

  const ctx = { siteName: SITE_NAME, absoluteUrl, orgUrl: absoluteUrl("/") }
  const profile = buildProfilePageJsonLd(agent, ctx)
  const videoLd = buildVideoJsonLd(agent, absoluteUrl, agentPath(agent.slug))
  const crumbs = buildBreadcrumbJsonLd([
    { name: "Home", url: absoluteUrl("/") },
    { name: "Travel specialists", url: absoluteUrl("/agents") },
    { name: agent.display_name, url: absoluteUrl(agentPath(agent.slug)) },
  ])

  const f = firstName(agent.display_name)
  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(profile) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(crumbs) }} />
        {videoLd.map((v, i) => <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(v) }} />)}

        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link> <span aria-hidden="true">/</span>{" "}
              <Link href="/agents" className="hover:underline">Travel specialists</Link> <span aria-hidden="true">/</span> <span>{agent.display_name}</span>
            </nav>
            <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              {agent.photo_url ? (
                // The hero photo: eager, with width and height so the page does not jump.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={agent.photo_url} alt={agentPhotoAlt(agent.display_name)} width={192} height={192} decoding="async" fetchPriority="high" className="h-48 w-48 rounded-2xl object-cover" />
              ) : (
                <AgentAvatar agent={agent} size={192} />
              )}
              <div className="text-center sm:text-left">
                {isAotm && aotm && <p className="mb-2 inline-block rounded-full bg-primary/10 px-3 py-0.5 text-xs font-semibold uppercase text-primary">Specialist of the month, {monthLabel(aotm.month)}</p>}
                <h1 className="text-balance text-3xl font-bold text-foreground sm:text-4xl">{agent.display_name}</h1>
                {agent.headline && <p className="mt-2 text-lg text-muted-foreground">{agent.headline}</p>}
                <dl className="mt-4 flex flex-wrap justify-center gap-x-8 gap-y-2 text-sm sm:justify-start">
                  {agent.years_experience !== null && agent.years_experience > 0 && <div><dt className="text-muted-foreground">Experience</dt><dd className="font-medium">{agent.years_experience} year{agent.years_experience === 1 ? "" : "s"} in travel</dd></div>}
                  {agent.languages.length > 0 && <div><dt className="text-muted-foreground">Languages</dt><dd className="font-medium">{agent.languages.join(", ")}</dd></div>}
                  {agent.asta_member && <div><dt className="text-muted-foreground">Member of</dt><dd className="font-medium">ASTA (American Society of Travel Advisors)</dd></div>}
                  {(agent.home_city || agent.region) && <div><dt className="text-muted-foreground">Based in</dt><dd className="font-medium">{[agent.home_city, agent.region].filter(Boolean).join(", ")}</dd></div>}
                </dl>
                <p className="mt-5"><a href="#plan" className="inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-bold uppercase text-primary-foreground hover:opacity-90">Plan your trip with {f}</a></p>
              </div>
            </div>
          </div>
        </div>

        <div className="container mx-auto max-w-3xl space-y-10 px-4 py-10">
          <section aria-labelledby="about">
            <h2 id="about" className="text-xl font-bold text-foreground">About {f}</h2>
            <div className="mt-3 space-y-3 text-muted-foreground">
              {(agent.bio ?? "").split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
            </div>
          </section>

          {agent.specialties.length > 0 && (
            <section aria-labelledby="specialties">
              <h2 id="specialties" className="text-xl font-bold text-foreground">Specialties</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {agent.specialties.map((sp) => {
                  const href = linkFor(sp)
                  return <li key={sp}>{href ? <Link href={href} className="inline-block rounded-full border px-4 py-1.5 text-sm hover:bg-muted">{sp}</Link> : <span className="inline-block rounded-full border px-4 py-1.5 text-sm">{sp}</span>}</li>
                })}
              </ul>
            </section>
          )}

          {certs.length > 0 && (
            <section aria-labelledby="certs">
              <h2 id="certs" className="text-xl font-bold text-foreground">Certifications</h2>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
                {certs.map((c) => <li key={`${c.name}-${c.issuer}`}>{c.name}{c.issuer ? `, ${c.issuer}` : ""}{c.year ? ` (${c.year})` : ""}</li>)}
              </ul>
            </section>
          )}

          {hosted.length > 0 && (
            <section aria-labelledby="trips">
              <h2 id="trips" className="text-xl font-bold text-foreground">Trips {f} is hosting</h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                {hosted.map((t) => (
                  <li key={t.slug} className="rounded-xl border bg-card p-4">
                    {/* utm_source lets the lead desk see which agent's page sent the visitor. It is a hint, not an assignment. */}
                    <Link href={`/packages/${t.slug}?utm_source=agent-${agent.slug}&utm_medium=agent-page`} className="font-semibold text-foreground hover:underline">{t.name}</Link>
                    {t.destination && <p className="text-xs uppercase text-muted-foreground">{t.destination}</p>}
                    {t.short_description && <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{t.short_description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {agent.social_links.length > 0 && (
            <section aria-labelledby="online">
              <h2 id="online" className="text-xl font-bold text-foreground">Find {f} online</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {agent.social_links.map((l) => (
                  <li key={l.url}><a href={l.url} target="_blank" rel="me noopener noreferrer" className="inline-block rounded-full border px-4 py-1.5 text-sm hover:bg-muted">{socialLabel(l)}</a></li>
                ))}
              </ul>
            </section>
          )}

          {achievements.length > 0 && (
            <section aria-labelledby="milestones">
              <h2 id="milestones" className="text-xl font-bold text-foreground">Milestones</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {achievements.map((a) => (
                  <li key={a.id} className="rounded-lg border bg-card px-3 py-2 text-sm">
                    <span className="block text-xs uppercase text-muted-foreground">{achievementLabel(a.kind)}{a.period ? `, ${a.period}` : ""}</span>
                    <span className="font-medium">{a.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {videos.length > 0 && (
            <section aria-labelledby="videos">
              <h2 id="videos" className="text-xl font-bold text-foreground">Hear from {f}</h2>
              <div className="mt-3 space-y-4">
                {videos.map(({ url, v }, i) => (
                  <div key={url} className="aspect-video w-full overflow-hidden rounded-xl border bg-muted">
                    <iframe src={v!.embedUrl} title={`${agent.display_name}: video ${i + 1}`} loading="lazy" className="h-full w-full" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section id="plan" aria-labelledby="plan-h" className="scroll-mt-20">
            <h2 id="plan-h" className="mb-4 text-center text-2xl font-bold text-foreground">Plan your trip with {f}</h2>
            <p className="mx-auto mb-6 max-w-xl text-center text-sm text-muted-foreground">Tell us about your trip. Our office reads every enquiry and matches you with the right travel specialist. For questions you can also call us at {site.phone}.</p>
            <Suspense fallback={null}>
              {/* agentInterest is a HINT only: the office assigns leads. Nothing here promises a particular agent. */}
              <ContactForm packageOptions={packages.map((p) => p.name)} language={language} phone={site.phone} agentInterest={agent.slug} />
            </Suspense>
          </section>
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
