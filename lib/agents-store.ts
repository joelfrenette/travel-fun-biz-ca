import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import {
  ACHIEVEMENT_PUBLIC_SELECT, AGENT_PUBLIC_SELECT, amountLike, cleanAgentInput, cleanText, isMonthKey, monthKey, publicCertifications,
  publishBlockers, suggestAgentOfMonth, toPublicAchievements, toPublicAgent, type AgentEditable, type PublicAchievement, type PublicAgent,
} from '@/lib/agents'
import { aotmCaption, aotmPost, socialCaption, toTopicIdea, ungroundedInDraft, welcomePost, type ContentDraft } from '@/lib/agents-content'
import { polishBio, polishHash, type PolishResult } from '@/lib/agents-polish'
import { buildPreview, type ImportFieldKey } from '@/lib/agents-import'
import { cleanSelfService, hashProfileToken, makeProfileToken, profileLinkExpiry, profileLinkState } from '@/lib/agents-token'
import { isTokenFormat } from '@/lib/agent-invites'
import { queueIdeas } from '@/lib/blog-topics'
import { otherHolders, setOfficeRole, takenMessage } from '@/lib/agents-office'

// Database side of the agent profiles. Server only.
//   PUBLIC reads: getSupabaseAdmin() + the explicit AGENT_PUBLIC_SELECT column list, then toPublicAgent() (which also
//   re-checks status and both consents). They fail soft: if the tables are not migrated yet, the lists are simply empty.
//   ADMIN reads/writes: the caller has already passed isAuthorized().

type Row = Record<string, unknown>

// ─── Public reads ───────────────────────────────────────────────────────────────────

export async function getPublishedAgents(): Promise<PublicAgent[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('agents')
      .select(AGENT_PUBLIC_SELECT)
      .eq('status', 'published')
      .eq('consent_photo', true)
      .eq('consent_bio', true)
      .order('featured', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('display_name', { ascending: true })
      .limit(500)
    if (error) return []
    return ((data ?? []) as unknown as Row[]).map(toPublicAgent).filter((a): a is PublicAgent => !!a)
  } catch {
    return []
  }
}

/** The published trips for a set of slugs, in the agent's order. A slug whose package is not published right now is skipped. */
export async function getPublishedPackagesBySlugs(slugs: string[]): Promise<{ slug: string; name: string; destination: string; short_description: string | null }[]> {
  if (!slugs.length) return []
  try {
    const { data } = await getSupabaseAdmin().from('travel_packages').select('slug, name, destination, short_description').in('slug', slugs).eq('status', 'published')
    const by = new Map(((data ?? []) as unknown as Row[]).map((r) => [String(r.slug), r]))
    return slugs.flatMap((sl) => {
      const r = by.get(sl)
      return r ? [{ slug: sl, name: String(r.name), destination: String(r.destination ?? ''), short_description: typeof r.short_description === 'string' ? r.short_description : null }] : []
    })
  } catch {
    return []
  }
}

export async function getPublishedAgent(slug: string): Promise<PublicAgent | null> {
  try {
    const { data, error } = await getSupabaseAdmin().from('agents').select(AGENT_PUBLIC_SELECT).eq('slug', slug).eq('status', 'published').maybeSingle()
    if (error || !data) return null
    return toPublicAgent(data as unknown as Row)
  } catch {
    return null
  }
}

/** Public achievements (public = true only; kind / title / period only; internal_value is never selected). */
export async function getPublicAchievements(agentIds: string[]): Promise<Map<string, PublicAchievement[]>> {
  const out = new Map<string, PublicAchievement[]>()
  if (!agentIds.length) return out
  try {
    const { data, error } = await getSupabaseAdmin().from('agent_achievements').select(ACHIEVEMENT_PUBLIC_SELECT).in('agent_id', agentIds).eq('public', true).order('created_at', { ascending: false }).limit(500)
    if (error) return out
    for (const a of toPublicAchievements((data ?? []) as unknown as Row[])) out.set(a.agent_id, [...(out.get(a.agent_id) ?? []), a])
  } catch {
    /* fail soft */
  }
  return out
}

export interface AgentOfMonth {
  month: string
  blurb: string | null
  agent: PublicAgent
}

/** The newest published agent of the month (this month or earlier) whose agent is still publicly visible. */
export async function getAgentOfMonth(now: Date = new Date()): Promise<AgentOfMonth | null> {
  try {
    const { data, error } = await getSupabaseAdmin().from('agent_of_month').select('month, agent_id, blurb').eq('published', true).lte('month', monthKey(now)).order('month', { ascending: false }).limit(6)
    if (error || !data?.length) return null
    const agents = await getPublishedAgents()
    for (const r of data as Row[]) {
      const agent = agents.find((a) => a.id === r.agent_id)
      if (agent) return { month: String(r.month), blurb: typeof r.blurb === 'string' && r.blurb.trim() ? r.blurb : null, agent }
    }
  } catch {
    /* fail soft */
  }
  return null
}

/** For the home page strip: the agent of the month plus up to `max` featured agents. Empty = the strip renders nothing. */
export async function getAgentsStrip(max = 4): Promise<{ aotm: AgentOfMonth | null; featured: PublicAgent[] }> {
  const [aotm, all] = await Promise.all([getAgentOfMonth(), getPublishedAgents()])
  const featured = all.filter((a) => a.featured && a.id !== aotm?.agent.id).slice(0, aotm ? max - 1 : max)
  return { aotm, featured }
}

// ─── Admin: roster ──────────────────────────────────────────────────────────────────

const admin = (): SupabaseClient => getSupabaseAdmin()

export async function listAgentsAdmin(): Promise<Row[]> {
  const { data, error } = await admin().from('agents').select('*').order('display_name', { ascending: true }).limit(1000)
  if (error) throw new Error(error.message)
  return (data ?? []) as Row[]
}

async function uniqueSlug(base: string, selfId?: string): Promise<string> {
  const { data } = await admin().from('agents').select('id, slug').like('slug', `${base}%`).limit(200)
  const taken = new Set(((data ?? []) as Row[]).filter((r) => r.id !== selfId).map((r) => String(r.slug)))
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now()}`
}

export async function saveAgent(id: string | null, input: Record<string, unknown>): Promise<{ ok: true; agent: Row } | { ok: false; errors: string[] }> {
  const cleaned = cleanAgentInput(input)
  if (!cleaned.ok) return cleaned
  const v = cleaned.value as AgentEditable & Record<string, unknown>
  if (!id && !v.display_name) return { ok: false, errors: ['A name is needed.'] }
  // The office role (admin only) is written on its own, after the profile, so a role someone else holds is never moved by accident:
  // it needs move_office_role: true (the editor sends it after the admin confirms).
  const wantsRole = 'office_role' in v
  const role = v.office_role ?? null
  const moveRole = input.move_office_role === true
  delete v.office_role
  if (wantsRole && role) {
    try {
      const holders = await otherHolders(admin(), role, id)
      if (holders.length > 0 && !moveRole) return { ok: false, errors: [takenMessage(role, holders)] }
    } catch {
      return { ok: false, errors: ['The office role column is not in the database yet. Apply migration 0057_agents_office_role.sql, then try again.'] }
    }
  }
  const withRole = async (row: Row): Promise<{ ok: true; agent: Row } | { ok: false; errors: string[] }> => {
    if (!wantsRole) return { ok: true, agent: row }
    const r = await setOfficeRole(admin(), String(row.id), role, moveRole)
    return r.ok ? { ok: true, agent: { ...row, office_role: role } } : { ok: false, errors: [`The profile was saved, but the office role was not: ${r.error}`] }
  }
  if (v.slug) v.slug = await uniqueSlug(v.slug, id ?? undefined)
  else if (!id && v.display_name) {
    const { slugify } = await import('@/lib/agents')
    v.slug = await uniqueSlug(slugify(v.display_name))
  }
  // Editing the live content of a published agent keeps them published only while the gate still holds.
  if (id) {
    const { data: cur } = await admin().from('agents').select('*').eq('id', id).maybeSingle()
    if (!cur) return { ok: false, errors: ['Agent not found.'] }
    const merged = { ...(cur as Row), ...v }
    if ((cur as Row).status === 'published' && publishBlockers(merged as never).length) v.status = 'draft'
    const { data, error } = await admin().from('agents').update({ ...v, updated_at: new Date().toISOString() }).eq('id', id).select('*').single()
    if (error) return { ok: false, errors: [error.message] }
    return withRole(data as Row)
  }
  const { data, error } = await admin().from('agents').insert({ ...v, status: 'draft', consent_photo: v.consent_photo === true, consent_bio: v.consent_bio === true }).select('*').single()
  if (error) return { ok: false, errors: [error.message] }
  return withRole(data as Row)
}

export async function deleteAgent(id: string): Promise<string | null> {
  const { error } = await admin().from('agents').delete().eq('id', id)
  return error ? error.message : null
}

/** Moves an agent between draft / ready / published. Publishing re-checks the gate in code and queues DRAFT content. */
export async function setAgentStatus(id: string, status: 'draft' | 'ready' | 'published'): Promise<{ ok: true; queued: string[] } | { ok: false; errors: string[] }> {
  const { data: cur, error } = await admin().from('agents').select('*').eq('id', id).maybeSingle()
  if (error || !cur) return { ok: false, errors: ['Agent not found.'] }
  const row = cur as Row
  if (status === 'published') {
    const blockers = publishBlockers(row as never)
    if (blockers.length) return { ok: false, errors: blockers }
  }
  const first = status === 'published' && !row.published_at
  const patch: Row = { status, updated_at: new Date().toISOString() }
  if (first) patch.published_at = new Date().toISOString()
  const up = await admin().from('agents').update(patch).eq('id', id)
  if (up.error) return { ok: false, errors: [up.error.message] }
  let queued: string[] = []
  if (first) {
    const pub = await getPublishedAgent(String(row.slug))
    if (pub) queued = await queueDrafts(pub, [welcomePost(pub), socialCaption(pub)])
  }
  return { ok: true, queued }
}

// ─── Admin: import ──────────────────────────────────────────────────────────────────

export async function previewImport(sheet: { headers: string[]; rows: string[][] }, mapping: (ImportFieldKey | '')[]) {
  let res = await admin().from('agents').select('slug, email, office_role').limit(2000)
  // Before migration 0057 there is no office_role column: read without it (no role is held yet).
  if (res.error) res = (await admin().from('agents').select('slug, email').limit(2000)) as unknown as typeof res
  const rows = (res.data ?? []) as Row[]
  return buildPreview(sheet, mapping, {
    slugs: rows.map((r) => String(r.slug)),
    emails: rows.map((r) => (typeof r.email === 'string' ? r.email : '')).filter(Boolean),
    officeRoles: rows.map((r) => (typeof r.office_role === 'string' ? r.office_role : '')).filter(Boolean),
  })
}

export async function runImport(sheet: { headers: string[]; rows: string[][] }, mapping: (ImportFieldKey | '')[]): Promise<{ created: number; skipped: number; errors: string[] }> {
  const preview = await previewImport(sheet, mapping)
  let created = 0
  let skipped = 0
  const errors: string[] = []
  for (const p of preview) {
    if (!p.ok || p.action !== 'new' || !p.value) {
      skipped++
      continue
    }
    // Always a draft with both consents OFF: import can never make anyone public.
    const r = await saveAgent(null, { ...p.value, consent_photo: false, consent_bio: false })
    if (r.ok) created++
    else {
      skipped++
      errors.push(`${p.value.display_name ?? `Row ${p.index + 2}`}: ${r.errors.join(' ')}`)
    }
  }
  return { created, skipped, errors }
}

// ─── Admin: self-service links ──────────────────────────────────────────────────────

export async function createProfileLink(agentId: string, days?: unknown, now: Date = new Date()): Promise<{ ok: true; token: string; path: string; expires_at: string } | { ok: false; error: string }> {
  const token = makeProfileToken()
  const expires = profileLinkExpiry(now, days)
  const { error } = await admin().from('agent_profile_links').insert({ token_hash: hashProfileToken(token), agent_id: agentId, expires_at: expires.toISOString() })
  if (error) return { ok: false, error: error.message }
  return { ok: true, token, path: `/agent-profile/${token}`, expires_at: expires.toISOString() }
}

export async function listProfileLinks(agentId: string): Promise<Row[]> {
  const { data } = await admin().from('agent_profile_links').select('id, created_at, expires_at, revoked_at, uses, last_used_at').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(20)
  return (data ?? []) as Row[]
}

export async function revokeProfileLink(agentId: string, linkId: string): Promise<string | null> {
  const { error } = await admin().from('agent_profile_links').update({ revoked_at: new Date().toISOString() }).eq('id', linkId).eq('agent_id', agentId)
  return error ? error.message : null
}

export interface LinkContext {
  link: Row
  agent: { id: string; display_name: string; bio: string | null; headline: string | null; specialties: string[]; years_experience: number | null; languages: string[]; video_urls: string[]; promoted_package_slugs: string[] }
}

/** Validates a token (format first, then hash lookup, then expiry). The agent sees only their own profile fields: never
 * email, phone or notes. */
export async function resolveProfileLink(token: string, now: Date = new Date()): Promise<{ ok: true; ctx: LinkContext } | { ok: false; status: number; error: string }> {
  if (!isTokenFormat(token)) return { ok: false, status: 404, error: 'This link is not valid.' }
  const { data: link, error } = await admin().from('agent_profile_links').select('*').eq('token_hash', hashProfileToken(token)).maybeSingle()
  if (error || !link) return { ok: false, status: 404, error: 'This link is not valid.' }
  const st = profileLinkState(link as never, now)
  if (!st.ok) return { ok: false, status: 410, error: st.reason === 'expired' ? 'This link has expired. Ask the office for a new one.' : 'This link is no longer active. Ask the office for a new one.' }
  const { data: a } = await admin().from('agents').select('id, display_name, bio, headline, specialties, years_experience, languages, video_urls, promoted_package_slugs').eq('id', (link as Row).agent_id).maybeSingle()
  if (!a) return { ok: false, status: 404, error: 'This link is not valid.' }
  return { ok: true, ctx: { link: link as Row, agent: a as LinkContext['agent'] } }
}

export async function submitSelfService(ctx: LinkContext, input: Record<string, unknown>): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const cleaned = cleanSelfService(input)
  if (!cleaned.ok) return cleaned
  // Only trips that are published right now can be proposed; anything else the agent typed or a stale page sent is dropped.
  if (cleaned.value.promoted_package_slugs.length) {
    const { data: live } = await admin().from('travel_packages').select('slug').in('slug', cleaned.value.promoted_package_slugs).eq('status', 'published')
    const ok = new Set(((live ?? []) as Row[]).map((r) => String(r.slug)))
    cleaned.value.promoted_package_slugs = cleaned.value.promoted_package_slugs.filter((x) => ok.has(x))
  }
  const { count } = await admin().from('agent_profile_submissions').select('id', { count: 'exact', head: true }).eq('link_id', String(ctx.link.id))
  if ((count ?? 0) >= 10) return { ok: false, errors: ['This link has been used the maximum number of times. Ask the office for a new one.'] }
  const { error } = await admin().from('agent_profile_submissions').insert({ agent_id: ctx.agent.id, link_id: ctx.link.id, payload: cleaned.value, status: 'pending' })
  if (error) return { ok: false, errors: [error.message] }
  await admin().from('agent_profile_links').update({ uses: Number(ctx.link.uses ?? 0) + 1, last_used_at: new Date().toISOString() }).eq('id', String(ctx.link.id))
  return { ok: true }
}

export async function listSubmissions(status: 'pending' | 'approved' | 'rejected' = 'pending'): Promise<Row[]> {
  const { data } = await admin().from('agent_profile_submissions').select('id, agent_id, payload, status, created_at').eq('status', status).order('created_at', { ascending: false }).limit(100)
  return (data ?? []) as Row[]
}

/** Approve copies the agent's own words onto the DRAFT profile (never publishes, never verifies a certification). */
export async function decideSubmission(id: string, action: 'approve' | 'reject'): Promise<string | null> {
  const { data: sub } = await admin().from('agent_profile_submissions').select('*').eq('id', id).maybeSingle()
  if (!sub || (sub as Row).status !== 'pending') return 'That submission was already decided.'
  const s = sub as Row
  if (action === 'approve') {
    const p = (s.payload ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const k of ['bio', 'headline', 'specialties', 'years_experience', 'languages', 'video_urls'] as const) if (p[k] !== undefined && p[k] !== '' && !(Array.isArray(p[k]) && (p[k] as unknown[]).length === 0) && p[k] !== null) patch[k] = p[k]
    if (p.photo_url) patch.photo_url = p.photo_url
    if (Array.isArray(p.certifications) && (p.certifications as unknown[]).length) patch.certifications = (p.certifications as Row[]).map((c) => ({ ...c, verified: false }))
    // The agent's own ticks are recorded; they can only turn a consent ON when the agent ticked it.
    if (p.consent_photo === true) patch.consent_photo = true
    if (p.consent_bio === true) patch.consent_bio = true
    const r = await saveAgent(String(s.agent_id), patch)
    if (!r.ok) return r.errors.join(' ')
    // Promoted trips and the testimonial statement: only what the agent actually sent, only on approval.
    const extra: Record<string, unknown> = {}
    if (Array.isArray(p.promoted_package_slugs)) extra.promoted_package_slugs = p.promoted_package_slugs
    if (typeof p.testimonial_text === 'string' && p.testimonial_text.trim()) extra.testimonial_text = p.testimonial_text
    if (Object.keys(extra).length) {
      const e = await admin().from('agents').update(extra).eq('id', String(s.agent_id))
      if (e.error) return e.error.message
    }
  }
  const up = await admin().from('agent_profile_submissions').update({ status: action === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString() }).eq('id', id)
  return up.error ? up.error.message : null
}

// ─── Admin: achievements and leaderboard ────────────────────────────────────────────

export async function listAchievementsAdmin(agentId?: string): Promise<Row[]> {
  let q = admin().from('agent_achievements').select('*').order('created_at', { ascending: false }).limit(500)
  if (agentId) q = q.eq('agent_id', agentId)
  const { data } = await q
  return (data ?? []) as Row[]
}

export async function saveAchievement(input: Record<string, unknown>): Promise<{ ok: true; row: Row } | { ok: false; errors: string[] }> {
  const title = cleanText(input.title, 140)
  if (!title) return { ok: false, errors: ['Add a title.'] }
  const isPublic = input.public === true
  if (isPublic && amountLike(title)) return { ok: false, errors: ['A public milestone cannot show an amount. Put the number in the private value box instead.'] }
  const v = input.internal_value === '' || input.internal_value == null ? null : Number(input.internal_value)
  const row = { agent_id: String(input.agent_id ?? ''), kind: cleanText(input.kind, 40) || 'other', title, period: cleanText(input.period, 40) || null, public: isPublic, internal_value: v !== null && Number.isFinite(v) ? v : null }
  if (!row.agent_id) return { ok: false, errors: ['Pick the agent.'] }
  const id = typeof input.id === 'string' ? input.id : null
  const res = id ? await admin().from('agent_achievements').update(row).eq('id', id).select('*').single() : await admin().from('agent_achievements').insert(row).select('*').single()
  return res.error ? { ok: false, errors: [res.error.message] } : { ok: true, row: res.data as Row }
}

export async function deleteAchievement(id: string): Promise<string | null> {
  const { error } = await admin().from('agent_achievements').delete().eq('id', id)
  return error ? error.message : null
}

/** INTERNAL ONLY: ranked by the private value. Never called from public code or any public route. */
export async function internalLeaderboard(): Promise<{ agent_id: string; display_name: string; total: number; count: number }[]> {
  const [a, g] = await Promise.all([admin().from('agents').select('id, display_name').limit(1000), admin().from('agent_achievements').select('agent_id, internal_value').not('internal_value', 'is', null).limit(5000)])
  const names = new Map(((a.data ?? []) as Row[]).map((r) => [String(r.id), String(r.display_name)]))
  const sums = new Map<string, { total: number; count: number }>()
  for (const r of (g.data ?? []) as Row[]) {
    const s = sums.get(String(r.agent_id)) ?? { total: 0, count: 0 }
    s.total += Number(r.internal_value) || 0
    s.count++
    sums.set(String(r.agent_id), s)
  }
  return [...sums.entries()].map(([agent_id, s]) => ({ agent_id, display_name: names.get(agent_id) ?? '(deleted)', ...s })).sort((x, y) => y.total - x.total)
}

// ─── Admin: agent of the month ──────────────────────────────────────────────────────

export async function listAgentOfMonth(): Promise<Row[]> {
  const { data } = await admin().from('agent_of_month').select('*').order('month', { ascending: false }).limit(36)
  return (data ?? []) as Row[]
}

export async function setAgentOfMonth(input: Record<string, unknown>): Promise<{ ok: true; queued: string[] } | { ok: false; errors: string[] }> {
  if (!isMonthKey(input.month)) return { ok: false, errors: ['Pick a month like 2026-11.'] }
  const agentId = String(input.agent_id ?? '')
  const pub = (await getPublishedAgents()).find((a) => a.id === agentId)
  const published = input.published === true
  if (published && !pub) return { ok: false, errors: ['Only a published, consented agent can be agent of the month.'] }
  const blurb = cleanText(input.blurb, 600, true) || null
  const { error } = await admin().from('agent_of_month').upsert({ month: input.month, agent_id: agentId, blurb, published }, { onConflict: 'month' })
  if (error) return { ok: false, errors: [error.message] }
  let queued: string[] = []
  if (published && pub) queued = await queueDrafts(pub, [aotmPost(pub, input.month, blurb), aotmCaption(pub, input.month, blurb)], blurb ?? '')
  return { ok: true, queued }
}

/** Suggestions from non-financial signals. The admin decides. */
export async function suggestMonthAgents(now: Date = new Date()) {
  const [agents, ach, aotm] = await Promise.all([getPublishedAgents(), listAchievementsAdmin(), listAgentOfMonth()])
  const publicCount = new Map<string, number>()
  for (const r of ach) if (r.public === true) publicCount.set(String(r.agent_id), (publicCount.get(String(r.agent_id)) ?? 0) + 1)
  const cur = now.getUTCFullYear() * 12 + now.getUTCMonth()
  const last = new Map<string, number>()
  for (const r of aotm) {
    const [y, m] = String(r.month).split('-').map(Number)
    const ago = cur - (y * 12 + (m - 1))
    const key = String(r.agent_id)
    if (!last.has(key) || ago < (last.get(key) as number)) last.set(key, ago)
  }
  return suggestAgentOfMonth(
    agents.map((a) => ({
      id: a.id, display_name: a.display_name, status: a.status, consent_photo: a.consent_photo, consent_bio: a.consent_bio, bio: a.bio, photo_url: a.photo_url,
      video_count: a.video_urls.length, verified_certifications: publicCertifications(a.certifications).length, public_achievements: publicCount.get(a.id) ?? 0,
      months_since_featured: last.has(a.id) ? (last.get(a.id) as number) : null,
    })),
  )
}

// ─── Content drafts ─────────────────────────────────────────────────────────────────

/** Saves DRAFTS (a human approves). Skips a draft of the same kind that is still open for that agent. */
export async function queueDrafts(a: PublicAgent, drafts: ContentDraft[], extraFacts = ''): Promise<string[]> {
  const done: string[] = []
  for (const d of drafts) {
    if (ungroundedInDraft(d, a, extraFacts).length) continue
    const { count } = await admin().from('agent_content_drafts').select('id', { count: 'exact', head: true }).eq('agent_id', a.id).eq('kind', d.kind).eq('title', d.title).in('status', ['draft', 'approved'])
    if ((count ?? 0) > 0) continue
    const { error } = await admin().from('agent_content_drafts').insert({ agent_id: a.id, kind: d.kind, title: d.title, body: d.body, status: 'draft' })
    if (!error) done.push(d.kind)
  }
  return done
}

export async function listDrafts(status: 'draft' | 'approved' | 'rejected' = 'draft'): Promise<Row[]> {
  const { data } = await admin().from('agent_content_drafts').select('id, agent_id, kind, title, body, status, created_at').neq('kind', 'bio_polish').eq('status', status).order('created_at', { ascending: false }).limit(100)
  return (data ?? []) as Row[]
}

/** Approve: a post draft is handed to the blog topic queue as a SUGGESTED topic (the existing approval queue decides when it
 * is written); a caption is just marked approved for copy and paste. Reject marks it rejected. */
export async function decideDraft(id: string, action: 'approve' | 'reject'): Promise<string | null> {
  const { data } = await admin().from('agent_content_drafts').select('*').eq('id', id).maybeSingle()
  const d = data as Row | null
  if (!d || d.status !== 'draft') return 'That draft was already decided.'
  if (action === 'approve' && (d.kind === 'welcome_post' || d.kind === 'aotm_post')) {
    const a = (await getPublishedAgents()).find((x) => x.id === d.agent_id)
    if (!a) return 'That agent is no longer public, so the post was not queued.'
    try {
      await queueIdeas(admin(), [toTopicIdea({ kind: d.kind as ContentDraft['kind'], title: String(d.title ?? ''), body: String(d.body) }, a)], 'suggested')
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not queue the post.'
    }
  }
  const up = await admin().from('agent_content_drafts').update({ status: action === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString() }).eq('id', id)
  return up.error ? up.error.message : null
}

// ─── Admin: bio polish (cached) ─────────────────────────────────────────────────────

export async function polishAgentBio(agentId: string, text: string): Promise<PolishResult> {
  const hash = polishHash(text)
  const { data } = await admin().from('agent_content_drafts').select('body').eq('agent_id', agentId).eq('kind', 'bio_polish').eq('input_hash', hash).maybeSingle()
  const res = await polishBio(text, { cached: (data as Row | null)?.body ? String((data as Row).body) : null })
  if (res.ok && !res.cached) await admin().from('agent_content_drafts').insert({ agent_id: agentId, kind: 'bio_polish', title: 'Bio polish', body: res.text, input_hash: hash, status: 'draft' })
  return res
}
