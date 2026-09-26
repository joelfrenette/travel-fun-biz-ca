import type { SupabaseClient } from '@supabase/supabase-js'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { findDuplicate } from '@/lib/content-dedupe'

// Ported from Nomad Escape Plan's modules/marketing/blog-topics.ts (Factory Phase 2:
// blog/autoblog), trimmed to what this site's own blog needs: no GSC "near-miss keyword"
// enrichment (that needs lib/keywords.ts's Search Console plumbing wired in on purpose, not as a
// side effect of this port - a real follow-up, not scope creep here) and no visa/passport
// material (100% Nomad's own domain). Kept: AI-suggested topics grounded in this site's actual
// packages and posts, an admin approval queue, and a same-keyword dedupe so the strategist never
// re-proposes something already live or already rejected.
export interface TopicIdea {
  angle: string
  keyword: string
  why: string
  source: string
}

export interface BlogTopicQueueRow {
  id: string
  angle: string
  keyword: string
  why: string
  source: string
  status: 'suggested' | 'approved' | 'used' | 'rejected'
  scheduled_for: string | null
  used_slug: string | null
  used_at: string | null
  created_at: string
}

// A trip-focused starting point when the AI is unconfigured or returns nothing usable. Not a
// content plan - just enough that "run autoblog now" has somewhere to land instead of failing.
const TOPIC_CLUSTERS: TopicIdea[] = [
  { angle: 'What to pack for a group trip so nobody’s the person who forgot something', keyword: 'group trip packing list', why: 'evergreen, low competition', source: 'static fallback' },
  { angle: 'How to talk your friends into finally booking the trip you keep planning', keyword: 'plan a group trip with friends', why: 'evergreen, matches our audience', source: 'static fallback' },
  { angle: 'Solo on a group trip: what it’s actually like the first time', keyword: 'solo travel group trip', why: 'evergreen, matches singles getaways', source: 'static fallback' },
  { angle: 'River cruise vs ocean cruise: which one fits your group', keyword: 'river cruise vs ocean cruise', why: 'evergreen, matches our packages', source: 'static fallback' },
]

/** Compact, real material for the AI prompt: recent post titles, live packages, and every keyword
 * already in play (queued or rejected) so it isn't re-suggested. Never invents anything - if a
 * table is empty, that section is just omitted. */
async function gatherTopicMaterial(admin: SupabaseClient): Promise<string> {
  const [{ data: posts }, { data: packages }, { data: queue }] = await Promise.all([
    admin.from('posts').select('title').order('created_at', { ascending: false }).limit(40),
    admin.from('travel_packages').select('name, destination, category').eq('status', 'published').limit(60),
    admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved', 'used', 'rejected']).limit(200),
  ])
  const lines: string[] = []
  if (posts?.length) lines.push(`Existing blog post titles (do not repeat these angles):\n${posts.map((p: { title: string }) => `- ${p.title}`).join('\n')}`)
  if (packages?.length) {
    const byDest = new Map<string, string[]>()
    for (const p of packages as { name: string; destination: string; category: string }[]) {
      byDest.set(p.destination, [...(byDest.get(p.destination) ?? []), `${p.name} (${p.category})`])
    }
    lines.push(`Real packages we sell, by destination:\n${[...byDest.entries()].map(([dest, names]) => `- ${dest}: ${names.join(', ')}`).join('\n')}`)
  }
  if (queue?.length) lines.push(`Keywords already queued, used or rejected (never propose these again):\n${(queue as { keyword: string }[]).map((q) => q.keyword).join(', ')}`)
  return lines.join('\n\n')
}

/** Ask the model for `count` new topic ideas grounded in real site material. Returns [] when the
 * AI is unconfigured or the reply isn't usable JSON - never invents ideas from nothing. */
export async function suggestTopics(admin: SupabaseClient, opts: { count: number }): Promise<TopicIdea[]> {
  if (!isAiConfigured()) return []
  const material = await gatherTopicMaterial(admin)
  const prompt = `You suggest blog post topics for a travel agency's site (hosted group trips, river and ocean cruises, singles getaways).

${material || '(no existing posts, packages or queued keywords yet)'}

Suggest ${opts.count} NEW topic ideas. Each must be a genuinely different angle from every title and keyword listed above - do not rephrase one of them. Ground each idea in something real from the material above when possible (a destination or package we actually sell), but a general travel-planning angle is fine too. Never invent a specific trip, price, date or traveler story that isn't in the material.

Return ONLY minified JSON of this exact shape, nothing else:
{"ideas":[{"angle":"<one-sentence post angle>","keyword":"<target search phrase, lowercase>","why":"<short reason this angle is worth writing, <100 chars>","source":"ai suggestion"}]}`

  try {
    const r = await callAnthropic({ max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 40_000 })
    if (!r || !r.res.ok) return []
    const data = await r.res.json()
    const parsed = parseModelJson<{ ideas?: TopicIdea[] }>(anthropicText(data))
    const ideas = Array.isArray(parsed?.ideas) ? parsed!.ideas : []
    return ideas.filter((i) => typeof i?.angle === 'string' && typeof i?.keyword === 'string' && i.angle && i.keyword)
  } catch {
    return []
  }
}

/** Insert ideas into the queue, skipping any whose keyword is already live (suggested/approved) -
 * the unique index would also reject it, but checking first avoids a noisy partial-insert error. */
export async function queueIdeas(admin: SupabaseClient, ideas: TopicIdea[], status: 'suggested' | 'approved' = 'suggested'): Promise<{ queued: number }> {
  if (ideas.length === 0) return { queued: 0 }
  const { data: live } = await admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved'])
  const liveKeywords = new Set((live ?? []).map((r: { keyword: string }) => r.keyword.toLowerCase()))
  const rows = ideas.filter((i) => !liveKeywords.has(i.keyword.toLowerCase())).map((i) => ({ ...i, status }))
  if (rows.length === 0) return { queued: 0 }
  const { error } = await admin.from('blog_topic_queue').insert(rows)
  if (error) throw new Error(error.message)
  return { queued: rows.length }
}

export async function listTopicQueue(admin: SupabaseClient): Promise<BlogTopicQueueRow[]> {
  const { data, error } = await admin.from('blog_topic_queue').select('*').order('created_at', { ascending: false }).limit(200)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function setTopicStatus(
  admin: SupabaseClient,
  id: string,
  status: BlogTopicQueueRow['status'],
  patch: { scheduled_for?: string | null; used_slug?: string | null } = {},
): Promise<void> {
  const { scheduled_for, used_slug } = patch
  const update: Record<string, unknown> = { status }
  if (scheduled_for !== undefined) update.scheduled_for = scheduled_for
  if (used_slug !== undefined) { update.used_slug = used_slug; update.used_at = new Date().toISOString() }
  const { error } = await admin.from('blog_topic_queue').update(update).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteTopic(admin: SupabaseClient, id: string): Promise<void> {
  const { error } = await admin.from('blog_topic_queue').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Approved topics whose scheduled date (if any) has arrived, oldest first. */
export async function dueApprovedTopics(admin: SupabaseClient): Promise<BlogTopicQueueRow[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await admin
    .from('blog_topic_queue')
    .select('*')
    .eq('status', 'approved')
    .or(`scheduled_for.is.null,scheduled_for.lte.${today}`)
    .order('scheduled_for', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

/** No admin-approved topic due today: ask the AI for one fresh idea not already covered, falling
 * back to a static cluster only if the AI is unconfigured or returns nothing. Never blocks a run
 * on human approval - approval gates the *queue*, not whether autoblog can write anything at all. */
export async function pickOneTopic(admin: SupabaseClient, existingPostTitles: string[]): Promise<TopicIdea | null> {
  const ideas = await suggestTopics(admin, { count: 3 })
  const fresh = ideas.find((i) => !findDuplicate(i.angle, existingPostTitles.map((title) => ({ title }))))
  if (fresh) return fresh
  const usedClusters = new Set((await admin.from('blog_topic_queue').select('keyword').eq('status', 'used')).data?.map((r: { keyword: string }) => r.keyword) ?? [])
  return TOPIC_CLUSTERS.find((c) => !usedClusters.has(c.keyword)) ?? TOPIC_CLUSTERS[0] ?? null
}
