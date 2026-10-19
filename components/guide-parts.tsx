import Link from "next/link"
import { articleHtml } from "@/lib/markdown"
import { linkPage, type AffiliateRule, type PageContext, type Part } from "@/lib/affiliate-linker"
import { AffiliateParts } from "@/components/affiliate-text"
import { guideFieldSet, linkPageFields, type FactsMode, type GuideFieldSet, type GuideLike, type LinkedFields } from "@/lib/affiliate-text-sources"

// The presentational pieces of a guide (key takeaways, article body, FAQ). No data fetching and no server-only
// imports, so the public pages (components/guide-page.tsx, the destination page) and the admin draft preview
// (a client page) render a guide in exactly the same way.

export interface GuideParts {
  name: string
  body: string
  faq: { q: string; a: string }[]
  key_takeaways: string[]
}

export { articleHtml }

/** The guide's article and FAQ answers with the word linker applied (WP22), plus how many automatic links were added.
 * Nothing stored is changed. With no rules the HTML is the same as articleHtml() and every answer is plain text.
 * (The whole page, summary and facts and takeaways included, is linkedGuidePage below.) */
export function linkedGuideContent(guide: Pick<GuideParts, "body" | "faq">, rules: AffiliateRule[] | null | undefined, context: PageContext): { bodyHtml: string; answers: Part[][]; count: number } {
  const linked = linkPage({ bodyHtml: articleHtml(guide.body), faqAnswers: guide.faq.map((f) => f.a) }, rules, context)
  return { bodyHtml: linked.bodyHtml, answers: linked.faq, count: linked.count }
}

/** Every linkable text of a guide or destination page (WP23: the summary under the title, the quick facts, the key
 * takeaways, the article and the FAQ answers), linked in reading order with ONE shared state: 3 per phrase and 6 per page
 * across all of them. `factsMode` says where the quick facts are shown (see lib/affiliate-text-sources.ts). */
export interface LinkedGuide {
  set: GuideFieldSet
  linked: LinkedFields
  summary: Part[]
  facts: Part[][]
  takeaways: Part[][]
  bodyHtml: string
  answers: Part[][]
  count: number
}

export function linkedGuidePage(guide: GuideLike, rules: AffiliateRule[] | null | undefined, context: PageContext, factsMode: FactsMode = "left"): LinkedGuide {
  const set = guideFieldSet(guide, context === "destinations" ? "destination" : "guide", factsMode)
  const linked = linkPageFields(set.fields, rules, context)
  return {
    set,
    linked,
    summary: linked.parts(set.summary),
    facts: set.facts.map((f) => linked.parts(f)),
    takeaways: set.takeaways.map((f) => linked.parts(f)),
    bodyHtml: linked.html(set.body),
    answers: set.faq.map((f) => linked.parts(f)),
    count: linked.count,
  }
}

/** `parts` are the takeaways already processed by linkedGuidePage() (one entry per takeaway). */
export function GuideTakeaways({ guide, parts }: { guide: GuideParts; parts?: Part[][] }) {
  if (guide.key_takeaways.length === 0) return null
  return (
    <aside id="key-takeaways" className="rounded-xl border bg-muted/30 p-5" aria-label="Key takeaways">
      <h2 className="mb-2 text-base font-bold uppercase text-foreground">Key takeaways</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
        {guide.key_takeaways.map((t, i) => <li key={t}>{parts?.[i] ? <AffiliateParts parts={parts[i]} /> : t}</li>)}
      </ul>
    </aside>
  )
}

/** `html` is the article already processed by linkedGuideContent(); without it the article is rendered as before. */
export function GuideArticle({ guide, html }: { guide: GuideParts; html?: string }) {
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html ?? articleHtml(guide.body) }} />
}

/** `answers` are the FAQ answers already processed by linkedGuideContent() (one entry per question). */
export function GuideFaqList({ guide, answers }: { guide: GuideParts; answers?: Part[][] }) {
  if (guide.faq.length === 0) return null
  return (
    <section aria-labelledby="guide-faq">
      <h2 id="guide-faq" className="mb-3 text-xl font-bold text-foreground">Frequently asked questions about {guide.name}</h2>
      <div className="divide-y rounded-xl border bg-card">
        {guide.faq.map((f, i) => (
          <details key={f.q} className="group p-4">
            <summary className="cursor-pointer list-none font-medium text-foreground">{f.q}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{answers?.[i] ? <AffiliateParts parts={answers[i]} /> : f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}

/** One related-guide card, already resolved to plain strings (see relatedGuideCards in lib/guides.ts), so this file
 * stays free of data-layer imports. */
export interface RelatedGuideCard {
  id: string
  href: string
  label: string
  name: string
  summary: string
}

export function RelatedGuidesSection({ guides }: { guides: RelatedGuideCard[] }) {
  if (guides.length === 0) return null
  return (
    <section aria-labelledby="related-guides-heading">
      <h2 id="related-guides-heading" className="mb-3 text-xl font-bold text-foreground">Related guides</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {guides.map((g) => (
          <li key={g.id}>
            <Link href={g.href} className="block h-full rounded-lg border bg-card p-4 transition-shadow hover:shadow-md">
              <span className="text-xs uppercase text-muted-foreground">{g.label}</span>
              <span className="mt-0.5 block font-semibold text-foreground">{g.name}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{g.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function BlogStoriesSection({ stories }: { stories: { id: string; slug: string; title: string }[] }) {
  if (stories.length === 0) return null
  return (
    <section aria-labelledby="stories-heading">
      <h2 id="stories-heading" className="mb-3 text-xl font-bold text-foreground">From the blog</h2>
      <ul className="space-y-1.5">
        {stories.map((p) => (
          <li key={p.id}><Link href={`/blog/${p.slug}`} className="font-medium text-foreground hover:underline">{p.title}</Link></li>
        ))}
      </ul>
    </section>
  )
}
