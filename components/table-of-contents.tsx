import type { TocItem } from "@/lib/toc"

/**
 * Contents list with jump links for a long post or guide (hub WP6). Plain server-rendered links: no script, so it
 * cannot shift the layout after load, and it works without JavaScript. Renders nothing for an empty list
 * (lib/toc.ts leaves it empty unless the article has four or more headings).
 */
export function TableOfContents({ items, className = "" }: { items: TocItem[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <nav aria-labelledby="toc-title" className={`rounded-xl border bg-muted/30 p-5 ${className}`.trim()}>
      <p id="toc-title" className="mb-2 text-base font-bold text-foreground">In this article</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} className="text-foreground underline-offset-2 hover:underline focus-visible:underline">{it.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
