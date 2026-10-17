import Link from "next/link"
import { renderMarkdown } from "@/lib/markdown"

// The presentational pieces of a guide (key takeaways, article body, FAQ). No data fetching and no server-only
// imports, so the public pages (components/guide-page.tsx, the destination page) and the admin draft preview
// (a client page) render a guide in exactly the same way.

export interface GuideParts {
  name: string
  body: string
  faq: { q: string; a: string }[]
  key_takeaways: string[]
}

/** Markdown to HTML, with links to pages of this site opening in the same tab (the markdown renderer opens every link in a new tab). */
function articleHtml(markdown: string): string {
  return renderMarkdown(markdown).replace(/<a href="(\/[^"]*)" target="_blank" rel="noopener noreferrer">/g, '<a href="$1">')
}

export function GuideTakeaways({ guide }: { guide: GuideParts }) {
  if (guide.key_takeaways.length === 0) return null
  return (
    <aside className="rounded-xl border bg-muted/30 p-5" aria-label="Key takeaways">
      <h2 className="mb-2 text-base font-bold uppercase text-foreground">Key takeaways</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
        {guide.key_takeaways.map((t) => <li key={t}>{t}</li>)}
      </ul>
    </aside>
  )
}

export function GuideArticle({ guide }: { guide: GuideParts }) {
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: articleHtml(guide.body) }} />
}

export function GuideFaqList({ guide }: { guide: GuideParts }) {
  if (guide.faq.length === 0) return null
  return (
    <section aria-labelledby="guide-faq">
      <h2 id="guide-faq" className="mb-3 text-xl font-bold text-foreground">Frequently asked questions about {guide.name}</h2>
      <div className="divide-y rounded-xl border bg-card">
        {guide.faq.map((f) => (
          <details key={f.q} className="group p-4">
            <summary className="cursor-pointer list-none font-medium text-foreground">{f.q}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{f.a}</p>
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
