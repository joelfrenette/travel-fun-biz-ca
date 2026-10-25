
// Travel specialist (agent) profiles: the PURE rules. No database, no network, no clock, so scripts/check-agents.ts can
// check them offline. The database side is lib/agents-store.ts.
//
// Privacy contract (enforced by scripts/check-agents.ts):
//   - Public code selects AGENT_PUBLIC_COLUMNS only, never "*". The private columns (email, phone, notes, internal_tags)
//     and agent_achievements.internal_value (sales / commission) are never selected by anything public.
//   - Nothing about an agent renders publicly unless status = published AND consent_photo AND consent_bio are true.
//   - A certification is shown only when verified = true.
//   - A public achievement carries kind / title / period. Never an amount.
//   - No agent phone or email is ever public. Leads go through the website funnel (the contact form).

/** Trims, strips control characters and caps a text field (same rules as lib/agent-invites.ts cleanText; copied so this
 * file stays free of node:crypto and can be used from client components). */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return ''
  const stripped = multiline ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
  return stripped.trim().slice(0, max)
}
export const AGENT_STATUSES = ['draft', 'ready', 'published'] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

/** The ONLY columns public code may read from `agents`. */
export const AGENT_PUBLIC_COLUMNS = [
  'id', 'slug', 'display_name', 'headline', 'bio', 'specialties', 'certifications', 'years_experience', 'languages',
  'home_city', 'region', 'photo_url', 'video_urls', 'status', 'consent_photo', 'consent_bio', 'featured', 'sort_order',
  'published_at', 'updated_at', 'social_links', 'asta_member', 'asta_verified', 'promoted_package_slugs',
] as const

/** Columns that must never appear in a public select, a page, JSON-LD or an API response a visitor can reach. */
export const AGENT_PRIVATE_COLUMNS = ['email', 'phone', 'address', 'notes', 'internal_tags', 'office_role', 'asta_number'] as const

// ─── Office team (CEO, CTO, Manager) ────────────────────────────────────────────────
// One roster person can hold an office role AND be an agent (one agents row, no second table). The role is ADMIN ONLY:
// it is never in AGENT_PUBLIC_COLUMNS, never in toPublicAgent, never in JSON-LD. A public job title, if wanted, is the
// existing headline field.

export const OFFICE_ROLES = ['ceo', 'cto', 'mgr'] as const
export type OfficeRole = (typeof OFFICE_ROLES)[number]

export const OFFICE_ROLE_LABEL: Record<OfficeRole, string> = { ceo: 'CEO', cto: 'CTO', mgr: 'Manager' }

export const isOfficeRole = (v: unknown): v is OfficeRole => typeof v === 'string' && (OFFICE_ROLES as readonly string[]).includes(v)

/** Reads a role from a database value or a spreadsheet cell. '' / none / null = no role. An unknown word is 'invalid'. */
export function parseOfficeRole(value: unknown): OfficeRole | null | 'invalid' {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return 'invalid'
  const t = value.trim().toLowerCase().replace(/\./g, '').replace(/[\s_-]+/g, ' ')
  if (t === '' || t === 'none' || t === 'no' || t === 'agent') return null
  if (t === 'ceo' || t === 'chief executive officer') return 'ceo'
  if (t === 'cto' || t === 'chief technology officer') return 'cto'
  if (t === 'mgr' || t === 'manager' || t === 'mgmt') return 'mgr'
  return 'invalid'
}

/** Pure: who holds each role in a roster. A role nobody holds is null. If a bad import ever left two holders, the first by name wins. */
export function officeHolders<T extends { id?: unknown; display_name?: unknown; office_role?: unknown }>(agents: T[]): Record<OfficeRole, T | null> {
  const out: Record<OfficeRole, T | null> = { ceo: null, cto: null, mgr: null }
  const sorted = [...agents].sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''), 'en', { sensitivity: 'base' }))
  for (const a of sorted) {
    const r = parseOfficeRole(a.office_role)
    if (r && r !== 'invalid' && !out[r]) out[r] = a
  }
  return out
}

/** Pure: the office team in CEO, CTO, Manager order (one entry per role that is held). */
export function officeTeam<T extends { id?: unknown; display_name?: unknown; office_role?: unknown }>(agents: T[]): { role: OfficeRole; agent: T }[] {
  const h = officeHolders(agents)
  return OFFICE_ROLES.flatMap((role) => (h[role] ? [{ role, agent: h[role] as T }] : []))
}

/** Pure: giving `role` to `agentId`. `from` is the current holder who would lose it (null when free or already this person's). */
export function planOfficeRole<T extends { id?: unknown; display_name?: unknown; office_role?: unknown }>(agents: T[], agentId: string | null, role: OfficeRole | null): { from: T | null } {
  if (!role) return { from: null }
  const holder = officeHolders(agents)[role]
  return { from: holder && String(holder.id) !== agentId ? holder : null }
}

export const AGENT_PUBLIC_SELECT = AGENT_PUBLIC_COLUMNS.join(', ')

/** The only achievement columns public code may read. `internal_value` is never in this list. */
export const ACHIEVEMENT_PUBLIC_COLUMNS = ['id', 'agent_id', 'kind', 'title', 'period'] as const
export const ACHIEVEMENT_PUBLIC_SELECT = ACHIEVEMENT_PUBLIC_COLUMNS.join(', ')

export interface AgentCertification {
  name: string
  issuer: string
  year: number | null
  verified: boolean
}

// ─── Social links and ASTA ──────────────────────────────────────────────────────────
// Every link is PRIVATE until the owner presses "Make public" on that one link (public === true). Imports and self-service can
// never set it. ASTA shows publicly only when it is a claim AND the owner ticked verified. The ASTA number is private.

export const SOCIAL_KINDS = {
  facebook_profile: { label: 'Facebook (personal page)', hosts: ['facebook.com', 'fb.com', 'fb.me', 'fb.watch'] },
  facebook_page: { label: 'Facebook (fan or business page)', hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  facebook_group: { label: 'Facebook group', hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  instagram: { label: 'Instagram', hosts: ['instagram.com', 'instagr.am'] },
  tiktok: { label: 'TikTok', hosts: ['tiktok.com'] },
  youtube: { label: 'YouTube channel', hosts: ['youtube.com', 'youtu.be'] },
  linkedin: { label: 'LinkedIn', hosts: ['linkedin.com', 'lnkd.in'] },
  x: { label: 'X (Twitter)', hosts: ['x.com', 'twitter.com'] },
  pinterest: { label: 'Pinterest', hosts: ['pinterest.com', 'pin.it'] },
  website: { label: 'Website', hosts: [] as string[] },
  other: { label: 'Other link', hosts: [] as string[] },
} as const
export type SocialKind = keyof typeof SOCIAL_KINDS
export const SOCIAL_KIND_KEYS = Object.keys(SOCIAL_KINDS) as SocialKind[]

export interface AgentSocialLink {
  kind: SocialKind
  /** Optional name shown on the button, for example "Shelby's Cruise Fans". */
  label: string
  url: string
  /** false until the owner makes this one link public. */
  public: boolean
}

const isSocialKind = (v: unknown): v is SocialKind => typeof v === 'string' && v in SOCIAL_KINDS

/** True when the https URL belongs to a host the kind allows (a website or other link may be anywhere). */
export function socialHostOk(kind: SocialKind, url: string): boolean {
  const hosts: readonly string[] = SOCIAL_KINDS[kind].hosts
  if (hosts.length === 0) return true
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^(www|m|web|l|mbasic)\./, '')
    return hosts.some((d) => h === d || h.endsWith(`.${d}`))
  } catch {
    return false
  }
}

/** Reads the stored list (or an admin edit). Drops anything not https, a named kind on the wrong site, repeats, and caps at 12.
 * `public` is true only when it is an explicit true. */
export function parseSocialLinks(value: unknown): AgentSocialLink[] {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  const out: AgentSocialLink[] = []
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const kind: SocialKind = isSocialKind(o.kind) ? o.kind : 'other'
    const url = cleanHttpsUrl(o.url)
    if (!url || !socialHostOk(kind, url) || out.some((x) => x.url === url)) continue
    out.push({ kind, label: cleanText(o.label, 60), url, public: o.public === true })
    if (out.length >= 12) break
  }
  return out
}

/** Links a visitor may see: public = true only. */
export function publicSocialLinks(links: AgentSocialLink[]): AgentSocialLink[] {
  return links.filter((l) => l.public === true)
}

export function socialLabel(l: Pick<AgentSocialLink, 'kind' | 'label'>): string {
  return l.label || SOCIAL_KINDS[l.kind].label
}

/** "ASTA member" may be shown only when the owner ticked verified. */
export function publicAstaMember(a: { asta_member?: unknown; asta_verified?: unknown }): boolean {
  return a.asta_member === true && a.asta_verified === true
}

export interface PublicAgent {
  id: string
  slug: string
  display_name: string
  headline: string | null
  bio: string | null
  specialties: string[]
  certifications: AgentCertification[]
  years_experience: number | null
  languages: string[]
  home_city: string | null
  region: string | null
  photo_url: string | null
  video_urls: string[]
  /** Only links the owner made public. */
  social_links: AgentSocialLink[]
  /** True only for a verified ASTA member. */
  asta_member: boolean
  /** Slugs the office approved; the page still shows one only if that package is published right now. */
  promoted_package_slugs: string[]
  status: AgentStatus
  consent_photo: boolean
  consent_bio: boolean
  featured: boolean
  sort_order: number
  published_at: string | null
  updated_at: string | null
}

export interface PublicAchievement {
  id: string
  agent_id: string
  kind: string
  title: string
  period: string | null
}

export const ACHIEVEMENT_KINDS: Record<string, string> = {
  high_commission: 'Top seller',
  growth_target: 'Growth target met',
  certification: 'New certification',
  anniversary: 'Work anniversary',
  award: 'Award',
  group_trip: 'Hosted a group trip',
  other: 'Milestone',
}

/** Slugs that would collide with a sibling route or read badly. */
const RESERVED_SLUGS = new Set(['new', 'admin', 'api', 'profile', 'page', 'index'])

/** A name as a visitor may see it: any parenthetical (for example a maiden name) is removed. */
export function publicName(raw: string): string {
  return raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
}

export function slugify(input: string): string {
  const s = publicName(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return RESERVED_SLUGS.has(s) ? `${s}-agent` : s
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 60
}

// ─── Cleaning ───────────────────────────────────────────────────────────────────────

function cleanList(value: unknown, maxItems: number, maxLen: number): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,\n|]/) : []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const t = cleanText(v, maxLen)
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
    if (out.length >= maxItems) break
  }
  return out
}

export function cleanSpecialties(value: unknown): string[] {
  return cleanList(value, 12, 60)
}

/** Package slugs an agent proposes: lowercase letters, digits and hyphens only, no duplicates, at most 12. */
export function cleanPackageSlugs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim().toLowerCase()
    if (/^[a-z0-9][a-z0-9-]{0,120}$/.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= 12) break
  }
  return out
}

export function cleanLanguages(value: unknown): string[] {
  return cleanList(value, 10, 40)
}

export function parseCertifications(value: unknown): AgentCertification[] {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = []
    }
  }
  if (!Array.isArray(raw)) return []
  const out: AgentCertification[] = []
  for (const c of raw.slice(0, 20)) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const name = cleanText(o.name, 120)
    if (!name) continue
    const y = typeof o.year === 'number' ? o.year : Number(o.year)
    out.push({
      name,
      issuer: cleanText(o.issuer, 120),
      year: Number.isInteger(y) && y >= 1950 && y <= 2100 ? y : null,
      // Only an explicit true counts. Anything an agent submits is NOT verified until an admin ticks it.
      verified: o.verified === true,
    })
  }
  return out
}

/** Certifications a visitor may see: verified ones only. */
export function publicCertifications(certs: AgentCertification[]): AgentCertification[] {
  return certs.filter((c) => c.verified === true)
}

export function cleanYears(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const digits = typeof value === 'number' ? String(value) : String(value).replace(/[^0-9.]/g, '')
  if (!/\d/.test(digits)) return null
  const n = Number(digits)
  if (!Number.isFinite(n) || n < 0 || n > 80) return null
  return Math.floor(n)
}

/** An https URL, or ''. */
export function cleanHttpsUrl(value: unknown, max = 2000): string {
  const u = cleanText(value, max)
  if (!u) return ''
  try {
    const p = new URL(u)
    return p.protocol === 'https:' ? p.toString() : ''
  } catch {
    return ''
  }
}

export interface ParsedVideo {
  provider: 'youtube' | 'vimeo'
  id: string
  embedUrl: string
  watchUrl: string
  thumbnailUrl: string | null
}

/** Only YouTube and Vimeo are embedded. Anything else is dropped (never framed). */
export function parseVideoUrl(url: string): ParsedVideo | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '')
  let yt: string | null = null
  if (host === 'youtu.be') yt = u.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') yt = u.searchParams.get('v')
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)
      if (m) yt = m[1]
    }
  }
  if (yt && /^[A-Za-z0-9_-]{11}$/.test(yt)) {
    return { provider: 'youtube', id: yt, embedUrl: `https://www.youtube-nocookie.com/embed/${yt}`, watchUrl: `https://www.youtube.com/watch?v=${yt}`, thumbnailUrl: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` }
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(?:^\/video)?\/(\d{6,12})(?:\/|$)/)
    if (m) return { provider: 'vimeo', id: m[1], embedUrl: `https://player.vimeo.com/video/${m[1]}`, watchUrl: `https://vimeo.com/${m[1]}`, thumbnailUrl: null }
  }
  return null
}

export function cleanVideoUrls(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : []
  const out: string[] = []
  for (const v of raw) {
    const u = cleanHttpsUrl(v)
    if (u && parseVideoUrl(u) && !out.includes(u)) out.push(u)
    if (out.length >= 3) break
  }
  return out
}

export interface AgentEditable {
  display_name?: string
  slug?: string
  headline?: string | null
  bio?: string | null
  specialties?: string[]
  certifications?: AgentCertification[]
  years_experience?: number | null
  languages?: string[]
  home_city?: string | null
  region?: string | null
  photo_url?: string | null
  video_urls?: string[]
  social_links?: AgentSocialLink[]
  asta_member?: boolean
  /** Admin only. */
  asta_number?: string | null
  asta_verified?: boolean
  consent_photo?: boolean
  consent_bio?: boolean
  featured?: boolean
  sort_order?: number
  email?: string | null
  phone?: string | null
  address?: string | null
  notes?: string | null
  internal_tags?: string[]
  /** Admin only. null = no office role. */
  office_role?: OfficeRole | null
}

const orNull = (s: string): string | null => (s ? s : null)

/** Whitelists and cleans an admin edit. A key that is absent stays absent (nothing is invented or defaulted). */
export function cleanAgentInput(input: Record<string, unknown>): { ok: true; value: AgentEditable } | { ok: false; errors: string[] } {
  const v: AgentEditable = {}
  const errors: string[] = []
  if ('display_name' in input) {
    const n = publicName(cleanText(input.display_name, 80))
    if (n.length < 2) errors.push('The name needs at least 2 letters.')
    else v.display_name = n
  }
  if ('slug' in input) {
    const s = slugify(String(input.slug ?? ''))
    if (!s) errors.push('The web address (slug) cannot be empty.')
    else v.slug = s
  }
  if ('headline' in input) v.headline = orNull(cleanText(input.headline, 140))
  if ('bio' in input) v.bio = orNull(cleanText(input.bio, 3000, true))
  if ('specialties' in input) v.specialties = cleanSpecialties(input.specialties)
  if ('certifications' in input) v.certifications = parseCertifications(input.certifications)
  if ('years_experience' in input) v.years_experience = cleanYears(input.years_experience)
  if ('languages' in input) v.languages = cleanLanguages(input.languages)
  if ('home_city' in input) v.home_city = orNull(cleanText(input.home_city, 80))
  if ('region' in input) v.region = orNull(cleanText(input.region, 80))
  if ('photo_url' in input) v.photo_url = orNull(cleanHttpsUrl(input.photo_url))
  if ('video_urls' in input) v.video_urls = cleanVideoUrls(input.video_urls)
  if ('social_links' in input) v.social_links = parseSocialLinks(input.social_links)
  if ('asta_member' in input) v.asta_member = input.asta_member === true
  if ('asta_number' in input) v.asta_number = orNull(cleanText(input.asta_number, 40))
  if ('asta_verified' in input) v.asta_verified = input.asta_verified === true
  if ('consent_photo' in input) v.consent_photo = input.consent_photo === true
  if ('consent_bio' in input) v.consent_bio = input.consent_bio === true
  if ('featured' in input) v.featured = input.featured === true
  if ('sort_order' in input) {
    const n = Number(input.sort_order)
    v.sort_order = Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.floor(n))) : 100
  }
  if ('email' in input) v.email = orNull(cleanText(input.email, 200).toLowerCase())
  if ('phone' in input) v.phone = orNull(cleanText(input.phone, 40))
  if ('address' in input) v.address = orNull(cleanText(input.address, 300))
  if ('notes' in input) v.notes = orNull(cleanText(input.notes, 2000, true))
  if ('internal_tags' in input) v.internal_tags = cleanList(input.internal_tags, 20, 40)
  if ('office_role' in input) {
    const r = parseOfficeRole(input.office_role)
    if (r === 'invalid') errors.push('Pick CEO, CTO, Manager or no office role.')
    else v.office_role = r
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v }
}

// ─── Publish rules ──────────────────────────────────────────────────────────────────

export interface PublishFacts {
  display_name?: string | null
  slug?: string | null
  bio?: string | null
  specialties?: string[] | null
  consent_photo?: boolean | null
  consent_bio?: boolean | null
  photo_url?: string | null
}

/** Empty list = may publish. Photo consent is required even when no photo is set, so a photo added later is already covered. */
export function publishBlockers(a: PublishFacts): string[] {
  const out: string[] = []
  if (!a.display_name || !a.display_name.trim()) out.push('Add the display name.')
  if (!isValidSlug(a.slug)) out.push('Add a valid web address (slug).')
  if (!a.bio || !a.bio.trim()) out.push('Add a bio.')
  if (!a.specialties || a.specialties.length < 1) out.push('Add at least one specialty.')
  if (a.consent_photo !== true) out.push('Photo consent is not ticked.')
  if (a.consent_bio !== true) out.push('Bio consent is not ticked.')
  return out
}

/** The one gate every public read goes through. */
export function isPubliclyVisible(a: { status?: unknown; consent_photo?: unknown; consent_bio?: unknown; bio?: unknown; display_name?: unknown }): boolean {
  return a.status === 'published' && a.consent_photo === true && a.consent_bio === true && typeof a.bio === 'string' && a.bio.trim().length > 0 && typeof a.display_name === 'string' && a.display_name.trim().length > 0
}

/** Turns a raw row (anything the database returned) into a PublicAgent, or null when it must not show. Copies ONLY the
 * public fields, so even a row that wrongly contained email or phone cannot leak them. The photo is dropped when photo
 * consent is missing (the gate above already requires it, so this is a second lock). */
export function toPublicAgent(row: Record<string, unknown> | null | undefined): PublicAgent | null {
  if (!row || !isPubliclyVisible(row)) return null
  const str = (k: string): string | null => (typeof row[k] === 'string' && (row[k] as string).trim() ? (row[k] as string) : null)
  const arr = (k: string): string[] => (Array.isArray(row[k]) ? (row[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  return {
    id: String(row.id),
    slug: String(row.slug),
    display_name: String(row.display_name),
    headline: str('headline'),
    bio: str('bio'),
    specialties: arr('specialties'),
    certifications: parseCertifications(row.certifications),
    years_experience: typeof row.years_experience === 'number' ? row.years_experience : null,
    languages: arr('languages'),
    home_city: str('home_city'),
    region: str('region'),
    photo_url: row.consent_photo === true ? cleanHttpsUrl(row.photo_url) || null : null,
    video_urls: arr('video_urls').filter((u) => !!parseVideoUrl(u)),
    social_links: publicSocialLinks(parseSocialLinks(row.social_links)),
    asta_member: publicAstaMember(row),
    promoted_package_slugs: cleanPackageSlugs(row.promoted_package_slugs),
    status: 'published',
    consent_photo: true,
    consent_bio: true,
    featured: row.featured === true,
    sort_order: typeof row.sort_order === 'number' ? row.sort_order : 100,
    published_at: str('published_at'),
    updated_at: str('updated_at'),
  }
}

/** Public achievements: only rows flagged public, and only kind / title / period (never internal_value). */
export function toPublicAchievements(rows: Record<string, unknown>[]): PublicAchievement[] {
  const out: PublicAchievement[] = []
  for (const r of rows) {
    // Rows come from a query already filtered to public = true (the flag itself is not selected); an explicit false is rejected.
    if (r.public === false) continue
    const title = typeof r.title === 'string' ? cleanText(r.title, 140) : ''
    if (!title || amountLike(title)) continue
    out.push({ id: String(r.id), agent_id: String(r.agent_id), kind: typeof r.kind === 'string' && r.kind in ACHIEVEMENT_KINDS ? r.kind : 'other', title, period: typeof r.period === 'string' && r.period.trim() ? cleanText(r.period, 40) : null })
  }
  return out
}

/** A public achievement title must not carry a money amount ("$250k in sales"). Such a title is not shown. */
export function amountLike(text: string): boolean {
  return /[$€£]\s?\d|\d\s?(?:k|m|mm)\b\s*(?:in|of)?\s*(?:sales|commission|revenue|bookings)|\b\d[\d,.]*\s?(?:cad|usd|dollars)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+%\s*(?:commission|growth)\b/i.test(text)
}

export function achievementLabel(kind: string): string {
  return ACHIEVEMENT_KINDS[kind] ?? ACHIEVEMENT_KINDS.other
}

// ─── Page text ──────────────────────────────────────────────────────────────────────

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** Honest alt text: says what the picture is, nothing it cannot know. */
export function agentPhotoAlt(name: string): string {
  return `Portrait of ${name}, travel specialist`
}

export function agentTitle(a: Pick<PublicAgent, 'display_name' | 'headline'>, siteName: string): string {
  const base = a.headline ? `${a.display_name}: ${a.headline}` : `${a.display_name}, travel specialist`
  const t = `${base} | ${siteName}`
  return t.length <= 70 ? t : `${a.display_name}, travel specialist | ${siteName}`
}

export function agentDescription(a: PublicAgent): string {
  const bits: string[] = []
  if (a.headline) bits.push(a.headline.replace(/[.!]+$/, ''))
  if (a.specialties.length) bits.push(`Specialties: ${a.specialties.slice(0, 4).join(', ')}`)
  if (a.years_experience !== null && a.years_experience > 0) bits.push(`${a.years_experience} years in travel`)
  const lead = bits.length ? `${bits.join('. ')}.` : ''
  const bio = (a.bio ?? '').replace(/\s+/g, ' ').trim()
  const full = `${lead} ${bio}`.trim()
  return full.length <= 158 ? full : `${full.slice(0, 155).replace(/\s+\S*$/, '')}...`
}

export function agentPath(slug: string): string {
  return `/agents/${slug}`
}

export function specialtyKey(s: string): string {
  return slugify(s)
}

// ─── JSON-LD (only the data we were given) ─────────────────────────────────────────

export function buildPersonJsonLd(a: PublicAgent, ctx: { siteName: string; absoluteUrl: (p: string) => string; orgUrl: string }) {
  const certs = publicCertifications(a.certifications)
  return {
    '@type': 'Person',
    '@id': `${ctx.absoluteUrl(agentPath(a.slug))}#person`,
    name: a.display_name,
    url: ctx.absoluteUrl(agentPath(a.slug)),
    jobTitle: 'Travel specialist',
    ...(a.headline ? { description: a.headline } : {}),
    ...(a.photo_url ? { image: a.photo_url } : {}),
    worksFor: { '@type': 'TravelAgency', name: ctx.siteName, url: ctx.orgUrl },
    ...(a.specialties.length ? { knowsAbout: a.specialties } : {}),
    ...(a.languages.length ? { knowsLanguage: a.languages } : {}),
    // Only links the owner made public. Verified ASTA members only.
    ...(a.social_links.length ? { sameAs: a.social_links.map((l) => l.url) } : {}),
    ...(a.asta_member ? { memberOf: { '@type': 'Organization', name: 'American Society of Travel Advisors (ASTA)', url: 'https://www.asta.org' } } : {}),
    ...(certs.length
      ? { hasCredential: certs.map((c) => ({ '@type': 'EducationalOccupationalCredential', name: c.name, ...(c.issuer ? { recognizedBy: { '@type': 'Organization', name: c.issuer } } : {}) })) }
      : {}),
    // Deliberately NO telephone / email: leads go through the website form.
  }
}

export function buildProfilePageJsonLd(a: PublicAgent, ctx: { siteName: string; absoluteUrl: (p: string) => string; orgUrl: string }) {
  const url = ctx.absoluteUrl(agentPath(a.slug))
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    name: `${a.display_name} | ${ctx.siteName}`,
    ...(a.published_at ? { dateCreated: a.published_at } : {}),
    ...(a.updated_at ? { dateModified: a.updated_at } : {}),
    mainEntity: buildPersonJsonLd(a, ctx),
  }
}

/** One VideoObject per embeddable video. Only the data we have: no invented upload date, no invented duration. */
export function buildVideoJsonLd(a: Pick<PublicAgent, 'display_name' | 'video_urls'>, absoluteUrl: (p: string) => string, pagePath: string) {
  const out: Record<string, unknown>[] = []
  a.video_urls.forEach((u, i) => {
    const v = parseVideoUrl(u)
    if (!v) return
    out.push({
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: `${a.display_name}: video ${i + 1}`,
      description: `A video shared by ${a.display_name}.`,
      embedUrl: v.embedUrl,
      ...(v.thumbnailUrl ? { thumbnailUrl: [v.thumbnailUrl] } : {}),
      url: absoluteUrl(pagePath),
    })
  })
  return out
}

export function buildAgentsCollectionJsonLd(agents: PublicAgent[], name: string, description: string, ctx: { absoluteUrl: (p: string) => string }) {
  const url = ctx.absoluteUrl('/agents')
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: agents.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: ctx.absoluteUrl(agentPath(a.slug)), name: a.display_name })),
    },
  }
}

// ─── Agent of the month: suggestion from NON-financial signals only ─────────────────

export interface SuggestInput {
  id: string
  display_name: string
  status: string
  consent_photo: boolean
  consent_bio: boolean
  bio: string | null
  photo_url: string | null
  video_count: number
  verified_certifications: number
  public_achievements: number
  /** Months since this agent was last agent of the month (null = never). */
  months_since_featured: number | null
}

/** Score 0..100 from profile quality and variety only. Sales, commission and lead counts are NEVER inputs. The admin decides. */
export function suggestAgentOfMonth(cands: SuggestInput[]): { id: string; display_name: string; score: number; reasons: string[] }[] {
  const out: { id: string; display_name: string; score: number; reasons: string[] }[] = []
  for (const c of cands) {
    if (!isPubliclyVisible({ status: c.status, consent_photo: c.consent_photo, consent_bio: c.consent_bio, bio: c.bio, display_name: c.display_name })) continue
    let score = 20
    const reasons: string[] = ['Published and fully consented']
    if (c.photo_url) { score += 15; reasons.push('Has a photo') }
    if (c.video_count > 0) { score += 15; reasons.push('Has a video') }
    if (c.verified_certifications > 0) { score += Math.min(20, c.verified_certifications * 10); reasons.push(`${c.verified_certifications} verified certification${c.verified_certifications === 1 ? '' : 's'}`) }
    if (c.public_achievements > 0) { score += Math.min(20, c.public_achievements * 10); reasons.push(`${c.public_achievements} public milestone${c.public_achievements === 1 ? '' : 's'}`) }
    if (c.months_since_featured === null) { score += 10; reasons.push('Not featured before') }
    else if (c.months_since_featured < 6) { score -= 25; reasons.push(`Featured ${c.months_since_featured} month${c.months_since_featured === 1 ? '' : 's'} ago`) }
    out.push({ id: c.id, display_name: c.display_name, score: Math.max(0, Math.min(100, score)), reasons })
  }
  return out.sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
}

export function isMonthKey(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(v)
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
