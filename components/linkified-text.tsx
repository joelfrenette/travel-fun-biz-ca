import Link from "next/link"
import { splitPathLinks } from "@/lib/path-links"

// Plain paragraph text where a link written as [words](/path) on this site becomes a real link. Only a path on this
// site is turned into a link (see lib/path-links.ts); anything else, including any other bracket text, stays exactly as
// written. Used for a trip page description, where the daily heal can add one "Related:" line of links to the end.
// The word linker version of this (the same text with affiliate phrase links added) is AffiliateLinkified in
// components/affiliate-text.tsx.

export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitPathLinks(text).map((seg, i) =>
        seg.kind === "path" ? (
          <Link key={i} href={seg.href} className="text-primary underline underline-offset-2 hover:no-underline">
            {seg.text}
          </Link>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}
