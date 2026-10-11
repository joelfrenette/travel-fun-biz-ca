import Link from "next/link"

// Plain paragraph text where a link written as [words](/path) on this site becomes a real link. Only a path on this
// site is turned into a link (it must start with one slash, never two, so no other website can be reached this way);
// anything else, including any other bracket text, stays exactly as written. Used for a trip page description, where
// the daily heal can add one "Related:" line of links to the end.

const LINK = /(\[[^\]\n]{1,120}\]\(\/(?!\/)[^)\s]*\))/
const LINK_ONLY = /^\[([^\]\n]{1,120})\]\((\/(?!\/)[^)\s]*)\)$/

export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {text.split(LINK).map((part, i) => {
        const m = LINK_ONLY.exec(part)
        if (!m) return <span key={i}>{part}</span>
        return (
          <Link key={i} href={m[2]} className="text-primary underline underline-offset-2 hover:no-underline">
            {m[1]}
          </Link>
        )
      })}
    </>
  )
}
