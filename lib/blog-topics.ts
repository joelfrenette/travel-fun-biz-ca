import type { SupabaseClient } from '@supabase/supabase-js'
import { callAnthropic, anthropicText, parseModelJson, isAiConfigured } from '@/lib/ai-verify'
import { findDuplicate } from '@/lib/content-dedupe'
import { getNearMissKeywords } from '@/lib/search-console'
import { SITE_ID } from '@/lib/site'

// Ported from Nomad Escape Plan's modules/marketing/blog-topics.ts (Factory Phase 2:
// blog/autoblog), trimmed to what this site's own blog needs: no visa/passport material (100%
// Nomad's own domain). GSC "near-miss keyword" enrichment was deferred out of that first port on
// purpose (roadmap sort_order 1020) and ships now, in lib/search-console.ts's getNearMissKeywords.
// Kept: AI-suggested topics grounded in this site's actual packages and posts, an admin approval
// queue, and a same-keyword dedupe so the strategist never re-proposes something already live or
// already rejected.
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
    admin.from('travel_packages').select('name, destination, category, short_description, available_from, available_to').eq('status', 'published').limit(60),
    admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved', 'used', 'rejected']).limit(200),
  ])
  const lines: string[] = []
  if (posts?.length) lines.push(`Existing blog post titles (do not repeat these angles):\n${posts.map((p: { title: string }) => `- ${p.title}`).join('\n')}`)
  if (packages?.length) {
    // short_description and dates are included so the AI grounds an angle in what's actually sold
    // (e.g. a sailing-yacht cruise, not a generic "overwater bungalow" cliche for the destination)
    // and in the real travel year - without these the model only sees name/destination/category and
    // fills the gap with plausible-sounding but wrong detail.
    const describe = (p: { name: string; category: string; short_description: string | null; available_from: string | null; available_to: string | null }) => {
      const bits = [`${p.name} (${p.category})`]
      if (p.short_description) bits.push(p.short_description)
      const year = p.available_from?.slice(0, 4) || p.available_to?.slice(0, 4)
      if (year) bits.push(`travels in ${year}`)
      return bits.join(' - ')
    }
    const byDest = new Map<string, string[]>()
    for (const p of packages as { name: string; destination: string; category: string; short_description: string | null; available_from: string | null; available_to: string | null }[]) {
      byDest.set(p.destination, [...(byDest.get(p.destination) ?? []), describe(p)])
    }
    lines.push(`Real packages we sell, by destination (use these details - never invent a detail that contradicts them):\n${[...byDest.entries()].map(([dest, names]) => `- ${dest}:\n  ${names.join('\n  ')}`).join('\n')}`)
  }
  if (queue?.length) lines.push(`Keywords already queued, used or rejected (never propose these again):\n${(queue as { keyword: string }[]).map((q) => q.keyword).join(', ')}`)

  // Found 2026-10-03: the admin's Keyword Research tool (real Keywords Everywhere search-volume
  // data, paid for with real credits) never fed into topic suggestions at all - Joel could look up
  // and "assign" a high-volume keyword to a page, but nothing downstream ever used that data to
  // decide what to write next. Surfacing the highest-volume keywords that have no real page
  // assigned yet (target_path IS NULL) gives the strategist validated search demand instead of
  // pure guesswork, the same spirit as the GSC near-miss signal below. Only ever a real recorded
  // `volume` number - never invented.
  const { data: researchedKeywords } = await admin
    .from('keyword_research')
    .select('keyword, volume')
    .eq('country', SITE_ID)
    .is('target_path', null)
    .not('volume', 'is', null)
    .order('volume', { ascending: false })
    .limit(10)
  if (researchedKeywords?.length) {
    lines.push(
      `Real search-volume data from Keywords Everywhere, not yet assigned to any page (favour one of these when it fits a real angle - never invent a volume number, only use what's listed):\n${(researchedKeywords as { keyword: string; volume: number }[])
        .map((r) => `- ${r.keyword} (${r.volume}/mo search volume)`)
        .join('\n')}`,
    )
  }

  // Never blocks a run — Search Console being unconfigured, empty, or briefly failing just means
  // this section is omitted, same as posts/packages/queue above when their table is empty.
  const nearMiss = await getNearMissKeywords(28, 10)
  if (nearMiss.length) {
    lines.push(
      `Already ranking 5-20 in Google (a focused post here is the fastest realistic win - favour at least one of these):\n${nearMiss
        .map((r) => `- ${r.query} (position ${r.position.toFixed(1)}, ${r.impressions} impressions/28d)`)
        .join('\n')}`,
    )
  }

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
    if (!r || !r.res.ok) {
      const body = r ? await r.res.text().catch(() => '') : ''
      console.error('[blog-topics] suggestTopics: Anthropic call failed', r ? `status ${r.res.status}` : '(no response)', body.slice(0, 500))
      return []
    }
    const data = await r.res.json()
    const parsed = parseModelJson<{ ideas?: TopicIdea[] }>(anthropicText(data))
    if (!parsed) console.error('[blog-topics] suggestTopics: model reply was not valid JSON of the expected shape')
    const ideas = Array.isArray(parsed?.ideas) ? parsed!.ideas : []
    return ideas.filter((i) => typeof i?.angle === 'string' && typeof i?.keyword === 'string' && i.angle && i.keyword)
  } catch (err) {
    console.error('[blog-topics] suggestTopics threw:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Insert ideas into the queue, skipping any whose keyword is already queued/approved OR already
 * used/rejected - the unique index only backs the queued/approved half, so without checking the
 * used/rejected statuses too a model slip could silently re-insert a keyword that was already
 * decided on. */
export async function queueIdeas(admin: SupabaseClient, ideas: TopicIdea[], status: 'suggested' | 'approved' = 'suggested'): Promise<{ queued: number }> {
  if (ideas.length === 0) return { queued: 0 }
  const { data: taken } = await admin.from('blog_topic_queue').select('keyword').in('status', ['suggested', 'approved', 'used', 'rejected'])
  const takenKeywords = new Set((taken ?? []).map((r: { keyword: string }) => r.keyword.toLowerCase()))
  const rows = ideas.filter((i) => !takenKeywords.has(i.keyword.toLowerCase())).map((i) => ({ ...i, status }))
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

export interface PackageGrounding {
  name: string
  slug: string
  destination: string
  short_description: string | null
  full_description: string | null
  highlights: string[] | null
  available_from: string | null
  available_to: string | null
}

/** Find the published package a topic is actually about, by checking whether the topic's angle
 * or keyword mentions the package's destination or name. Returns null when nothing matches -
 * never guesses a "closest" package, since grounding a post in the wrong product would be worse
 * than not grounding it at all. */
export async function findGroundingPackage(admin: SupabaseClient, topic: Pick<TopicIdea, 'angle' | 'keyword'>): Promise<PackageGrounding | null> {
  const { data, error } = await admin
    .from('travel_packages')
    .select('name, slug, destination, short_description, full_description, highlights, available_from, available_to')
    .eq('status', 'published')
    .limit(200)
  if (error || !data) return null
  const haystack = `${topic.angle} ${topic.keyword}`.toLowerCase()
  const rows = data as PackageGrounding[]
  return (
    rows.find((p) => {
      const dest = p.destination?.toLowerCase()
      const name = p.name?.toLowerCase()
      return (!!dest && haystack.includes(dest)) || (!!name && haystack.includes(name))
    }) ?? null
  )
}

/** Fold a matched package's real facts into the angle text handed to composeFullPost, so its
 * AI steps (which only ever see `angle`, not the DB) can't contradict the actual product. Returns
 * the angle unchanged when no package matched - composeFullPost still works for general
 * travel-advice topics, it just isn't grounded in a specific package. Never invents a detail: only
 * facts already on the `pkg` row are included. */
export function groundAngleInPackage(angle: string, pkg: PackageGrounding | null): string {
  if (!pkg) return angle
  const facts: string[] = [`Real package being promoted: "${pkg.name}" (${pkg.destination}).`]
  if (pkg.short_description) facts.push(`What it actually is: ${pkg.short_description}`)
  if (pkg.highlights?.length) facts.push(`Its real stops/highlights (do not invent different ones): ${pkg.highlights.join(', ')}`)
  if (pkg.available_from || pkg.available_to) facts.push(`Its real travel dates: ${pkg.available_from ?? 'unknown'} to ${pkg.available_to ?? 'unknown'}`)
  facts.push('Name this real package by name in the post and use only these real stops/dates/details - never invent a different itinerary, stop list, or date range.')
  return `${angle}\n\n${facts.join(' ')}`
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
