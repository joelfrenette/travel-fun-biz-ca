import Link from "next/link"
import { jsonLdHtml, buildBreadcrumbJsonLd } from "@/lib/jsonld"
import { absoluteUrl } from "@/lib/site"

export interface Crumb {
  name: string
  /** Site path such as "/packages". Leave empty for the current page (shown as plain text, not a link). */
  path?: string
}

/**
 * Visible breadcrumb trail plus its BreadcrumbList structured data (hub WP6). The last crumb is the current page. The visible
 * trail and the JSON-LD are built from the same list, so they cannot disagree. `currentPath` is the current page's own path.
 */
export function Breadcrumbs({ crumbs, currentPath, className = "mb-4 text-sm text-muted-foreground" }: { crumbs: Crumb[]; currentPath: string; className?: string }) {
  if (crumbs.length < 2) return null
  const ld = buildBreadcrumbJsonLd(crumbs.map((c, i) => ({ name: c.name, url: absoluteUrl(i === crumbs.length - 1 ? currentPath : c.path || "/") })))
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(ld) }} />
      <nav aria-label="Breadcrumb" className={className}>
        <ol className="flex flex-wrap items-center gap-x-1.5">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1
            return (
              <li key={`${c.name}-${i}`} className="flex items-center gap-x-1.5">
                {last ? <span aria-current="page" className="text-foreground">{c.name}</span> : <Link href={c.path || "/"} className="hover:underline">{c.name}</Link>}
                {!last && <span aria-hidden="true">/</span>}
              </li>
            )
          })}
        </ol>
      </nav>
    </>
  )
}
