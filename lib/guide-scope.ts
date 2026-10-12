// Scope labels for guide pages (growth loop WP16). A page keeps its kind (destinations, hotels, resorts, cruise
// lines, ships, river cruises, yachts) and gets a second label that says how wide it is: a country, a region, a
// city, a port of call, a supplier (a company with many properties), one property, a cruise line, one ship or a
// ship class. Pure code, no database, so it runs in the browser and in the offline check.
//
// Rules: a scope is only INFERRED from a short list of well-known names (countries, regions, ports, supplier
// brands) or from words in the name ("Resorts", "class"). Anything else is left empty for a person to set; nothing
// is guessed. A stored scope always wins over the inferred one.

export const GUIDE_SCOPES = ['country', 'region', 'city', 'port', 'supplier', 'property', 'line', 'ship', 'class'] as const
export type GuideScope = (typeof GUIDE_SCOPES)[number]

export const SCOPE_LABEL: Record<GuideScope, string> = {
  country: 'Country',
  region: 'Region',
  city: 'City',
  port: 'Port of call',
  supplier: 'Supplier',
  property: 'Property',
  line: 'Cruise line',
  ship: 'Ship',
  class: 'Ship class',
}

export function isGuideScope(value: unknown): value is GuideScope {
  return typeof value === 'string' && (GUIDE_SCOPES as readonly string[]).includes(value)
}

/** A stored value to a scope, or null when it is empty or not one of the nine. */
export function parseScope(value: unknown): GuideScope | null {
  return isGuideScope(value) ? value : null
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Plain geography, no travel facts. Matching is on the whole normalised name.
const COUNTRIES = new Set(
  [
    'Mexico', 'Jamaica', 'Dominican Republic', 'Cuba', 'Bahamas', 'Barbados', 'Aruba', 'Costa Rica', 'Panama', 'Belize', 'Italy', 'Greece', 'Spain', 'Portugal', 'France',
    'Croatia', 'Turkey', 'Egypt', 'Morocco', 'Iceland', 'Ireland', 'England', 'Scotland', 'Germany', 'Austria', 'Switzerland', 'Hungary', 'Netherlands', 'Norway', 'Sweden',
    'Denmark', 'Finland', 'Australia', 'New Zealand', 'Japan', 'Thailand', 'Vietnam', 'Peru', 'Brazil', 'Argentina', 'Chile', 'Ecuador', 'Canada', 'United States', 'Montenegro',
    'Malta', 'Cyprus', 'Israel', 'Jordan', 'South Africa', 'Kenya', 'Tanzania', 'India', 'Maldives', 'Fiji', 'Antigua', 'Grenada', 'Saint Lucia', 'St Lucia', 'Curacao', 'Bermuda',
  ].map(norm),
)
const REGIONS = new Set(
  [
    'Caribbean', 'Mediterranean', 'Alaska', 'Amalfi Coast', 'Tuscany', 'Sicily', 'Southern Italy', 'Riviera Maya', 'French Riviera', 'Algarve', 'Dalmatian Coast', 'Greek Islands',
    'Scandinavia', 'Baltic', 'Europe', 'Hawaii', 'Tahiti', 'Patagonia', 'Yucatan', 'Danube', 'Rhine', 'Douro', 'Nile', 'Adriatic', 'Aegean', 'Norwegian Fjords',
  ].map(norm),
)
const PORTS = new Set(
  ['Nassau', 'Cozumel', 'Civitavecchia', 'Juneau', 'Ketchikan', 'Skagway', 'Montego Bay', 'Ocho Rios', 'Grand Cayman', 'Roatan', 'Falmouth', 'Piraeus', 'Barcelona', 'Southampton', 'Kotor', 'Dubrovnik', 'Split', 'Valletta', 'Villefranche', 'Livorno', 'Naples', 'Venice', 'Ensenada', 'Port Canaveral', 'Fort Lauderdale', 'Galveston', 'Cartagena', 'Puerto Plata', 'La Romana', 'Costa Maya', 'Belize City', 'Charlotte Amalie', 'Philipsburg', 'Bridgetown'].map(norm),
)
const SUPPLIER_NAMES = ['sandals', 'beaches', 'club med', 'royalton', 'hard rock', 'riu', 'iberostar', 'secrets', 'dreams', 'melia', 'barcelo', 'palace resorts', 'karisma']

/** The scope a page most likely has, or null when it cannot be told from the kind and name alone. */
export function inferScope(kind: string, name: string): GuideScope | null {
  const n = norm(name)
  if (!n) return null
  if (kind === 'destinations') {
    if (COUNTRIES.has(n)) return 'country'
    if (REGIONS.has(n)) return 'region'
    if (PORTS.has(n)) return 'port'
    return null
  }
  if (kind === 'hotels' || kind === 'resorts') {
    if (/\b(resorts|hotels)$/.test(n) || SUPPLIER_NAMES.some((s) => n === s || n === `${s} resorts` || n === `${s} resort collection`)) return 'supplier'
    return 'property'
  }
  if (kind === 'cruise-lines') return 'line'
  if (kind === 'ships') return /\bclass\b/.test(n) ? 'class' : 'ship'
  return null
}

/** The label to show for a page: its stored scope, else the inferred one, else null (the caller shows the kind). */
export function scopeOf(page: { kind: string; name: string; scope?: unknown }): GuideScope | null {
  return parseScope(page.scope) ?? inferScope(page.kind, page.name)
}

// ---------------------------------------------------------------------------------------------------
// Parent chains: a city under a country, a port under a region, a ship under a cruise line.
// ---------------------------------------------------------------------------------------------------

export interface ScopeNode {
  kind: string
  slug: string
  name: string
  parent_slug: string | null
  scope?: unknown
}

const MAX_DEPTH = 4

/** Finds the page a parent_slug points at. A page of the same kind wins (a ship under its cruise line is another
 * kind, a port under a city is the same), then a destination, then any other kind. */
export function resolveParent(child: Pick<ScopeNode, 'kind' | 'parent_slug'>, nodes: ScopeNode[]): ScopeNode | null {
  if (!child.parent_slug) return null
  const hits = nodes.filter((n) => n.slug === child.parent_slug)
  if (hits.length === 0) return null
  return hits.find((n) => n.kind === child.kind) ?? hits.find((n) => n.kind === 'destinations') ?? hits[0]
}

/** The parents of a page, outermost first, not including the page. Stops at a missing parent, at a loop and
 * at four levels, so a bad parent_slug can never hang a page. */
export function parentChain(start: Pick<ScopeNode, 'kind' | 'slug' | 'parent_slug'>, nodes: ScopeNode[]): ScopeNode[] {
  const out: ScopeNode[] = []
  const seen = new Set<string>([`${start.kind}:${start.slug}`])
  let current: Pick<ScopeNode, 'kind' | 'parent_slug'> = start
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = resolveParent(current, nodes)
    if (!parent) break
    const key = `${parent.kind}:${parent.slug}`
    if (seen.has(key)) break
    seen.add(key)
    out.unshift(parent)
    current = parent
  }
  return out
}

/** Pages whose parent is this page, grouped by scope label (or kind label when a page has no scope), biggest
 * group first. Used for the "Inside X" block on a page. */
export function groupChildren<T extends ScopeNode>(parent: Pick<ScopeNode, 'kind' | 'slug'>, nodes: T[], kindLabel: (kind: string) => string): { label: string; items: T[] }[] {
  const kids = nodes.filter((n) => n.parent_slug === parent.slug && !(n.kind === parent.kind && n.slug === parent.slug))
  const groups = new Map<string, T[]>()
  for (const k of kids) {
    const s = scopeOf(k)
    const label = s ? SCOPE_LABEL[s] : kindLabel(k.kind)
    groups.set(label, [...(groups.get(label) ?? []), k])
  }
  return [...groups.entries()]
    .map(([label, items]) => ({ label, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
}
