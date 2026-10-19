import Link from "next/link"
import { goPath } from "@/lib/affiliate-go"
import type { LinkifiedPart } from "@/lib/affiliate-text-sources"
import { DEFAULT_DISCLOSURE } from "@/lib/affiliate-partners"
import { translate } from "@/lib/i18n"
import type { Part } from "@/lib/affiliate-linker"
import type { Language } from "@/lib/preferences"

// WP22/WP23: pieces for text that the word linker (lib/affiliate-linker.ts) has processed. No hooks, no handlers, no
// server-only imports. Text is rendered by React (always escaped); a link is built from the short-link slug only.
// AffiliateParts is for the linked output of a plain-text field; the article HTML of a field comes from the page linker.

/** Text parts as React nodes: plain strings are escaped by React, a link is an anchor to /go/<slug> in a new tab. */
export function AffiliateParts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <a key={i} href={goPath(p.slug)} target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>
            {p.text}
          </a>
        ),
      )}
    </>
  )
}

/** Text that may hold links to pages of this site ([words](/path), see lib/path-links.ts) AND automatic phrase links: the
 * page linker's output for a "linkified" field. Site links open in the same tab, phrase links in a new one. */
export function AffiliateLinkified({ parts }: { parts: LinkifiedPart[] }) {
  // Each run of ordinary text sits in its own <span>, exactly as the trip description has always been rendered.
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : "href" in p ? (
          <Link key={i} href={p.href} className="text-primary underline underline-offset-2 hover:no-underline">
            {p.text}
          </Link>
        ) : (
          <a key={i} href={goPath(p.slug)} target="_blank" rel="sponsored nofollow noopener" data-affiliate-auto>
            {p.text}
          </a>
        ),
      )}
    </>
  )
}

/** The small line under an article, shown only when at least one automatic link was put on the page. With `wrapperClassName`
 * the line sits in a wrapper that exists ONLY when the line does, so a page with no links gets no empty space. */
export function AffiliateAutoDisclosure({ count, language, wrapperClassName }: { count: number; language: Language; wrapperClassName?: string }) {
  if (count <= 0) return null
  const line = (
    <p className="text-xs text-muted-foreground" data-affiliate-disclosure data-affiliate-auto-disclosure>
      {translate(language, DEFAULT_DISCLOSURE)}
    </p>
  )
  return wrapperClassName ? <div className={wrapperClassName}>{line}</div> : line
}

/** True when linked text parts hold at least one automatic link. */
export const partsHaveLink = (parts: Part[]): boolean => parts.some((p) => typeof p !== "string")
