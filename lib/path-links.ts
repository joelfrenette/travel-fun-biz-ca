// A link written as [words](/path) inside plain text becomes a real link to a page of THIS site. Used for a trip page
// description (the daily heal can add a "Related:" line of links to the end) and by the word linker, which must not link
// inside one. Only a path on this site is accepted: it must start with one slash that is not followed by another slash or
// a backslash (browsers treat "/\" like "//"), and it may not contain a backslash anywhere, so no other website can be
// reached this way. Anything else, including any other bracket text, stays exactly as written.

const LINK = /(\[[^\]\n]{1,120}\]\(\/(?![/\\])[^)\s\\]*\))/
const LINK_ONLY = /^\[([^\]\n]{1,120})\]\((\/(?![/\\])[^)\s\\]*)\)$/

export type PathSegment = { kind: 'text'; text: string } | { kind: 'path'; text: string; href: string }

/** Splits plain text into ordinary text and site links, in order. Empty text pieces are KEPT (as the page always rendered
 * them: one element per piece), so a page with no word links renders exactly the markup it rendered before WP23. */
export function splitPathLinks(text: string): PathSegment[] {
  const out: PathSegment[] = []
  for (const part of String(text ?? '').split(LINK)) {
    const m = LINK_ONLY.exec(part)
    out.push(m ? { kind: 'path', text: m[1], href: m[2] } : { kind: 'text', text: part })
  }
  return out
}
