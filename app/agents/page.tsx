import type { Metadata } from "next"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { AgentCard } from "@/components/agents-ui"
import { getAgentOfMonth, getPublishedAgents } from "@/lib/agents-store"
import { buildAgentsCollectionJsonLd, monthLabel, specialtyKey } from "@/lib/agents"
import { buildBreadcrumbJsonLd, jsonLdHtml } from "@/lib/jsonld"
import { getVisitorPreferences } from "@/lib/preferences"
import { SITE_NAME, DEFAULT_OG_IMAGE, absoluteUrl } from "@/lib/site"

const title = `Our Travel Specialists | ${SITE_NAME}`
const description = "Meet the travel specialists behind our group trips, cruises and singles getaways: their specialties, languages and experience. Send an enquiry and our office matches you with the right one."
const url = absoluteUrl("/agents")

// A filtered view (?specialty=) always points its canonical at /agents, so the filter chips never create competing pages.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: url },
  openGraph: { title, description, url, type: "website", images: [{ url: DEFAULT_OG_IMAGE, alt: SITE_NAME }] },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_OG_IMAGE] },
}

export default async function AgentsPage({ searchParams }: { searchParams?: { specialty?: string } }) {
  const { language, currency } = getVisitorPreferences()
  const [all, aotm] = await Promise.all([getPublishedAgents(), getAgentOfMonth()])
  const chips = new Map<string, string>()
  for (const a of all) for (const sp of a.specialties) if (!chips.has(specialtyKey(sp))) chips.set(specialtyKey(sp), sp)
  const active = typeof searchParams?.specialty === "string" ? searchParams.specialty : ""
  const agents = active ? all.filter((a) => a.specialties.some((sp) => specialtyKey(sp) === active)) : all
  const featured = agents.filter((a) => a.featured && a.id !== aotm?.agent.id)
  const rest = agents.filter((a) => !a.featured && a.id !== aotm?.agent.id)
  const showAotm = aotm && (!active || agents.some((a) => a.id === aotm.agent.id))

  const collection = buildAgentsCollectionJsonLd(all, `Travel specialists at ${SITE_NAME}`, description, { absoluteUrl })
  const crumbs = buildBreadcrumbJsonLd([{ name: "Home", url: absoluteUrl("/") }, { name: "Travel specialists", url }])

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(collection) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(crumbs) }} />
        <div className="border-b bg-muted/30">
          <div className="container mx-auto px-4 py-10">
            <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
              <Link href="/" className="hover:underline">Home</Link> <span aria-hidden="true">/</span> <span>Travel specialists</span>
            </nav>
            <h1 className="mt-3 text-balance text-3xl font-bold uppercase text-foreground sm:text-4xl">Our travel specialists</h1>
            <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="container mx-auto px-4 py-10">
          {all.length === 0 ? (
            <p className="text-center text-muted-foreground">Our specialist profiles are coming soon. <Link href="/#contact" className="font-medium text-primary hover:underline">Send us an enquiry</Link> and we will match you with the right person.</p>
          ) : (
            <>
              {chips.size > 1 && (
                <nav aria-label="Filter by specialty" className="mb-8">
                  <ul className="flex flex-wrap justify-center gap-2 text-sm">
                    <li><Link href="/agents" aria-current={!active ? "page" : undefined} className={`inline-block rounded-full border px-4 py-2 hover:bg-muted ${!active ? "bg-muted font-medium" : ""}`}>All specialties</Link></li>
                    {[...chips.entries()].map(([key, label]) => (
                      <li key={key}><Link href={`/agents?specialty=${key}`} aria-current={active === key ? "page" : undefined} className={`inline-block rounded-full border px-4 py-2 hover:bg-muted ${active === key ? "bg-muted font-medium" : ""}`}>{label}</Link></li>
                    ))}
                  </ul>
                </nav>
              )}

              {showAotm && aotm && (
                <section aria-labelledby="aotm" className="mx-auto mb-10 max-w-3xl rounded-xl border bg-primary/5 p-6 text-center">
                  <h2 id="aotm" className="text-sm font-semibold uppercase text-primary">Specialist of the month, {monthLabel(aotm.month)}</h2>
                  <ul className="mx-auto mt-4 max-w-xs"><AgentCard agent={aotm.agent} /></ul>
                  {aotm.blurb && <p className="mt-4 text-pretty text-sm text-muted-foreground">{aotm.blurb}</p>}
                </section>
              )}

              {agents.length === 0 && <p className="text-center text-muted-foreground">No specialist matches that filter. <Link href="/agents" className="font-medium text-primary hover:underline">See everyone</Link>.</p>}
              {featured.length > 0 && (
                <section aria-labelledby="featured" className="mb-10">
                  <h2 id="featured" className="mb-4 text-xl font-bold text-foreground">Featured specialists</h2>
                  <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{featured.map((a) => <AgentCard key={a.id} agent={a} />)}</ul>
                </section>
              )}
              {rest.length > 0 && (
                <section aria-labelledby="all-agents">
                  <h2 id="all-agents" className="mb-4 text-xl font-bold text-foreground">{featured.length > 0 ? "More specialists" : "All specialists"}</h2>
                  <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{rest.map((a) => <AgentCard key={a.id} agent={a} />)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}
