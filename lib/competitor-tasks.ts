import { MANUAL_STEPS } from '@/lib/competitor-scan'

// Manual tasks that come out of the competitor scanner: the two things no tool here can read (a competitor's Google Business Profile
// categories and services, and their backlinks). Shaped like the entries of lib/link-targets.ts (id, title, how, searchPhrase, officialSite,
// effort, value) so the Link building page can list them. Pure: nothing is stored, nothing is sent.

export interface CompetitorTask {
  /** Stable id: lowercase letters, digits and dashes. */
  id: string
  group: 'competitors'
  title: string
  how: string
  searchPhrase: string
  officialSite: string
  effort: 'low' | 'medium' | 'high'
  value: 'low' | 'medium' | 'high'
  /** The numbered steps behind `how`. */
  steps: readonly string[]
}

const hostLabel = (origin: string): string => {
  try {
    return new URL(origin).hostname.replace(/^www\./, '')
  } catch {
    return origin
  }
}
const idPart = (origin: string): string => hostLabel(origin).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Two tasks per tracked competitor: copy-worthy Google Business Profile categories, and pick realistic backlinks. Pure. */
export function competitorTasks(origins: readonly string[]): CompetitorTask[] {
  const out: CompetitorTask[] = []
  for (const origin of origins) {
    const host = hostLabel(origin)
    const id = idPart(origin)
    out.push({
      id: `comp-gbp-${id}`,
      group: 'competitors',
      title: `Read ${host}'s Google Business Profile categories`,
      how: `Open their Google Maps listing, read the category and the services under About, then add the ones that are really true for us to our own profile.`,
      searchPhrase: `${host} Google Maps travel agency`,
      officialSite: 'Google Maps',
      effort: 'low',
      value: 'medium',
      steps: MANUAL_STEPS.businessProfile,
    })
    out.push({
      id: `comp-backlinks-${id}`,
      group: 'competitors',
      title: `Find who links to ${host} and pick realistic ones`,
      how: `Export their referring domains from a backlink tool (Ahrefs Webmaster Tools free tier, Semrush or Ubersuggest), then pick the realistic ones to approach yourself.`,
      searchPhrase: `${host} backlinks referring domains`,
      officialSite: 'Ahrefs Webmaster Tools, Semrush or Ubersuggest',
      effort: 'medium',
      value: 'high',
      steps: MANUAL_STEPS.backlinks,
    })
  }
  return out
}
