// The "Still missing" checklist of the add-a-trip wizard (growth loop WP13). Pure: no database, no network, no
// server imports, so the wizard (a client component) and the offline checks can both use it. It looks at a trip row and
// lists the FACTS nothing has found yet. Facts are never guessed: each one is something a person has to supply, so
// each item carries a one-click nudge that reopens the "Drop what you have" step for exactly that item.

export interface MissingFact {
  key: string
  /** Shown as the checklist line. */
  label: string
  /** The row columns that count as "found" (any one filled means found). */
  fields: string[]
  /** The button text. */
  nudge: string
  /** What the nudge reopens: the file drop, the link box or the text box. */
  accepts: 'any' | 'link' | 'text'
  /** A sentence shown above the drop box when the nudge is used. */
  hint: string
}

export const FACT_CHECKLIST: MissingFact[] = [
  { key: 'price', label: 'Price', fields: ['price_display', 'price_value'], nudge: 'Drop the price list', accepts: 'any', hint: 'Drop the price list, a screenshot with the price, or paste the price.' },
  { key: 'dates', label: 'Dates', fields: ['available_from', 'available_to', 'departure_dates'], nudge: 'Drop the dates', accepts: 'any', hint: 'Drop the schedule or a screenshot that shows the dates, or paste them.' },
  { key: 'duration', label: 'How long the trip is', fields: ['duration', 'duration_days'], nudge: 'Say how long it is', accepts: 'text', hint: 'Paste a line that says how many days or nights the trip is.' },
  { key: 'group', label: 'Group size', fields: ['max_people'], nudge: 'Add the group size', accepts: 'text', hint: 'Paste a line that says how big the group is.' },
  { key: 'included', label: 'What is included', fields: ['price_includes'], nudge: 'Paste what is included', accepts: 'text', hint: 'Paste the list of what the price includes.' },
  { key: 'not_included', label: 'What is not included', fields: ['not_included'], nudge: 'Paste what is not included', accepts: 'text', hint: 'Paste the list of what the price does not include.' },
  { key: 'itinerary', label: 'Day by day plan', fields: ['itinerary'], nudge: 'Paste the itinerary', accepts: 'any', hint: 'Paste the itinerary or drop the page that has it.' },
  { key: 'booking', label: 'Booking link', fields: ['booking_url', 'more_info_url'], nudge: 'Add the supplier link', accepts: 'link', hint: 'Paste the supplier link for this trip.' },
]

function filled(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'number') return Number.isFinite(v)
  return true
}

/**
 * Is the trip's category still "not set yet"? Empty counts. So does the table's default ('Adventure') on a stub: a draft
 * with no descriptions and no highlights, where nobody can have chosen it. A trip with real text keeps its category.
 */
export function categoryNotSet(row: Record<string, unknown>): boolean {
  const cat = typeof row.category === 'string' ? row.category.trim() : ''
  if (!cat) return true
  const stub = row.status === 'draft' && !filled(row.full_description) && !filled(row.short_description) && !filled(row.highlights)
  return stub && cat === 'Adventure'
}

/** The facts no column holds yet, in the checklist's order. (The category is judged by categoryNotSet, not by "any value".) */
export function missingFacts(row: Record<string, unknown>): MissingFact[] {
  const out = FACT_CHECKLIST.filter((m) => !m.fields.some((f) => filled(row[f])))
  if (categoryNotSet(row) && filled(row.name) && !isPlaceholderName(row.name)) {
    out.push({ key: 'category', label: 'Kind of trip', fields: ['category'], nudge: 'Say what kind of trip it is', accepts: 'text', hint: 'Paste a line that says what kind of trip this is (cruise, beach, cultural, family ...).' })
  }
  return out
}

/** The placeholder name a draft gets before the AI proposes a real one. */
export function isPlaceholderName(name: unknown): boolean {
  return typeof name !== 'string' || !name.trim() || /^new trip\b/i.test(name.trim())
}
