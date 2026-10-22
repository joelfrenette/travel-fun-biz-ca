// Title and H1 wording for trip pages, decided at render time from the stored row. Nothing here is written back to the
// database: the stored name, meta title and descriptions are never changed. Pure, no imports, testable offline.

const ANZ = /\baustralia\s*(?:and|&|\+)\s*new\s+zealand\b/i
const ALREADY = /\bfrom\s+canada\b/i
// The row's own text says the trip leaves from somewhere else (or is for a different market): then we say nothing about Canada.
const OTHER_ORIGIN = /\bfrom\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united\s+states|uk|united\s+kingdom|europe)\b|\bus[- ]based\b/i

export interface FromCanadaInput {
  name: string
  short_description?: string | null
  full_description?: string | null
  meta_title?: string | null
  meta_description?: string | null
}

/** True when the trip is an Australia and New Zealand trip and its own stored text does not say it leaves from somewhere
 * else or already says "from Canada". Pure. */
export function wantsFromCanada(pkg: FromCanadaInput): boolean {
  if (!ANZ.test(pkg.name)) return false
  const own = [pkg.name, pkg.short_description, pkg.full_description, pkg.meta_title, pkg.meta_description].filter((s): s is string => typeof s === 'string')
  if (own.some((s) => ALREADY.test(s))) return false
  if (own.some((s) => OTHER_ORIGIN.test(s))) return false
  return true
}

/** "Australia and New Zealand Tour" -> "Australia and New Zealand Tour from Canada". A trailing year stays last:
 * "... Cruise 2027" -> "... Cruise from Canada 2027". Returns the text unchanged when it already says "from Canada". */
export function insertFromCanada(text: string): string {
  const t = text.trim()
  if (!t || ALREADY.test(t)) return text
  const m = /^(.*?)(\s+(?:19|20)\d{2})$/.exec(t)
  return m ? `${m[1]} from Canada${m[2]}` : `${t} from Canada`
}

/** The H1 for a trip page: the stored name, with "from Canada" added only for an upcoming Australia and New Zealand trip
 * whose own text does not point elsewhere. Past trips (recaps) keep their name exactly. */
export function tripHeading(pkg: FromCanadaInput, isPast: boolean): string {
  if (isPast || !wantsFromCanada(pkg)) return pkg.name
  return insertFromCanada(pkg.name)
}

/** The page title: `base` is the title the page already builds (the stored meta title or the default pattern). When the trip
 * qualifies, the trip name inside it gets "from Canada" after it. A title that does not contain the name is left alone
 * (a hand-written meta title is never rewritten blindly). */
export function tripTitle(pkg: FromCanadaInput, base: string, isPast: boolean): string {
  if (isPast || !wantsFromCanada(pkg) || ALREADY.test(base)) return base
  const i = base.indexOf(pkg.name)
  if (i < 0) return base
  return `${base.slice(0, i)}${insertFromCanada(pkg.name)}${base.slice(i + pkg.name.length)}`
}
