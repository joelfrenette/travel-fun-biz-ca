import { goPath } from "@/lib/affiliate-go"
import { DEFAULT_DISCLOSURE } from "@/lib/affiliate-partners"
import { translate } from "@/lib/i18n"
import type { Part } from "@/lib/affiliate-linker"
import type { Language } from "@/lib/preferences"

// WP22: pieces for text that the word linker (lib/affiliate-linker.ts) has processed. No hooks, no handlers, no
// server-only imports. Text is rendered by React (always escaped); a link is built from the short-link slug only.

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

/** The small line under an article, shown only when at least one automatic link was put on the page. */
export function AffiliateAutoDisclosure({ count, language }: { count: number; language: Language }) {
  if (count <= 0) return null
  return (
    <p className="text-xs text-muted-foreground" data-affiliate-disclosure data-affiliate-auto-disclosure>
      {translate(language, DEFAULT_DISCLOSURE)}
    </p>
  )
}
