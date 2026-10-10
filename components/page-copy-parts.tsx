import { renderMarkdown } from "@/lib/markdown"

// The presentational pieces of a compare or best-time page's written copy: the intro (above the package grid),
// the Key takeaways box and the FAQ list. No data fetching, so both route files render them the same way. A page
// with no published copy renders none of this and looks exactly as it did before.

export interface PageCopyParts {
  intro: string
  faq: { q: string; a: string }[]
  key_takeaways: string[]
}

/** Markdown to HTML, with links to pages of this site opening in the same tab (the renderer opens every link in a new tab). */
function introHtml(markdown: string): string {
  return renderMarkdown(markdown).replace(/<a href="(\/[^"]*)" target="_blank" rel="noopener noreferrer">/g, '<a href="$1">')
}

export function PageCopyIntro({ copy }: { copy: PageCopyParts }) {
  if (!copy.intro.trim()) return null
  return <div className="markdown-body max-w-3xl" dangerouslySetInnerHTML={{ __html: introHtml(copy.intro) }} />
}

export function PageCopyTakeaways({ copy }: { copy: PageCopyParts }) {
  if (copy.key_takeaways.length === 0) return null
  return (
    <aside className="max-w-3xl rounded-xl border bg-muted/30 p-5" aria-label="Key takeaways">
      <h2 className="mb-2 text-base font-bold uppercase text-foreground">Key takeaways</h2>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
        {copy.key_takeaways.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </aside>
  )
}

export function PageCopyFaq({ copy }: { copy: PageCopyParts }) {
  if (copy.faq.length === 0) return null
  return (
    <section aria-labelledby="page-copy-faq" className="max-w-3xl">
      <h2 id="page-copy-faq" className="mb-3 text-xl font-bold text-foreground">Frequently asked questions</h2>
      <div className="divide-y rounded-xl border bg-card">
        {copy.faq.map((f, i) => (
          <details key={i} className="group p-4">
            <summary className="cursor-pointer list-none font-medium text-foreground">{f.q}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
