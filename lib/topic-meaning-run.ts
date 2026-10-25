import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { appendDecisions, decision, isVetoedIn, policyKey, policyEnabled, readVetoes } from '@/lib/auto-decisions'
import { blockIfDry } from '@/lib/dry-run'
import { callAnthropic, anthropicText, isAiConfigured, parseModelJson } from '@/lib/ai-verify'
import { isNewsSlug } from '@/lib/news-post'
import { duplicateReason, findSameMeaning, type MeaningDoc, type MeaningMatch, type TopicText } from '@/lib/topic-meaning'

// Server side of the "same meaning" topic check (the pure scoring is lib/topic-meaning.ts). Read this first:
//  - The deterministic layer is ON unless app_settings.auto_policy_topic_meaning is exactly 'off'.
//  - The AI tie-break is OFF unless app_settings.topic_meaning_ai is exactly 'on'. It is asked only about BORDERLINE pairs, at most
//    AI_DAILY_CAP times per UTC day (counter in app_settings, topic_meaning_ai_calls:<day>), and a failed or unclear answer means "not a duplicate".
//  - Every function FAILS OPEN: an unreadable table or setting never blocks a topic (the older word-matching checks still apply).
//  - A duplicate is never dropped silently: a queue row becomes 'rejected' with "duplicate of <slug>" added to its `why`, and a line goes to
//    the Autopilot decisions log (policy topic_meaning) with an Undo that puts the row back (and a veto so it is not rejected again).

export const TOPIC_MEANING_SWITCH = policyKey('topic_meaning')
export const TOPIC_MEANING_AI_SWITCH = 'topic_meaning_ai'
export const AI_DAILY_CAP = 10
export const REJECTED_LOOKBACK_DAYS = 120
const aiCountKey = (now: Date) => `topic_meaning_ai_calls:${now.toISOString().slice(0, 10)}`
const DUP_MARK = 'duplicate of '

export interface MeaningContext {
  docs: MeaningDoc[]
  vetoes: string[]
  aiEnabled: boolean
  now: Date
}

/** True when the AI tie-break may run (switch exactly 'on'). Pure. */
export const aiLayerEnabled = (raw: string | null | undefined): boolean => raw === 'on'

/** Reads the switches and what already exists. Returns null when the layer is off or the posts cannot be read (fail open). */
export async function loadMeaningContext(admin: SupabaseClient, now: Date = new Date()): Promise<MeaningContext | null> {
  try {
    if (!policyEnabled(await getSetting(admin, TOPIC_MEANING_SWITCH))) return null
    const since = new Date(now.getTime() - REJECTED_LOOKBACK_DAYS * 86_400_000).toISOString()
    const [posts, queue, aiRaw, vetoes] = await Promise.all([
      admin.from('posts').select('slug, title, primary_keyword, body, status, publish_date, created_at').limit(600),
      admin.from('blog_topic_queue').select('id, keyword, angle, why, status, created_at').in('status', ['suggested', 'approved', 'rejected']).limit(500),
      getSetting(admin, TOPIC_MEANING_AI_SWITCH).catch(() => null),
      readVetoes(admin),
    ])
    if (posts.error || !posts.data) return null
    const docs: MeaningDoc[] = []
    const draftSince = now.getTime() - 30 * 86_400_000
    for (const p of posts.data as { slug: string; title: string; primary_keyword: string | null; body: string | null; status: string; publish_date: string | null; created_at: string | null }[]) {
      if (isNewsSlug(p.slug)) continue
      if (p.status !== 'published' && !(p.status === 'draft' && Date.parse(p.created_at ?? '') >= draftSince)) continue
      docs.push({ kind: 'post', slug: p.slug, title: p.title, keyword: p.primary_keyword, body_chars: (p.body ?? '').length, date: p.publish_date || p.created_at })
    }
    if (!queue.error) {
      for (const q of (queue.data ?? []) as { id: string; keyword: string; angle: string; why: string | null; status: string; created_at: string }[]) {
        if (q.status === 'rejected') {
          // Only recent rejections, and not ones rejected FOR being a duplicate (they would chain: "duplicate of a duplicate").
          if (Date.parse(q.created_at) < Date.parse(since) || (q.why ?? '').includes(DUP_MARK)) continue
          docs.push({ kind: 'rejected', slug: q.keyword, title: q.angle, keyword: q.keyword, id: q.id })
        } else {
          docs.push({ kind: 'queued', slug: q.keyword, title: q.angle, keyword: q.keyword, id: q.id })
        }
      }
    }
    return { docs, vetoes, aiEnabled: aiLayerEnabled(aiRaw), now }
  } catch {
    return null
  }
}

/** Asks the model whether two topics would be answered by the same page. Counts against the daily cap. false on any trouble. */
async function aiSaysSame(admin: SupabaseClient, topic: TopicText, match: MeaningMatch, now: Date): Promise<boolean> {
  try {
    if (!isAiConfigured()) return false
    const key = aiCountKey(now)
    const used = Number((await getSetting(admin, key)) ?? 0) || 0
    if (used >= AI_DAILY_CAP) return false
    await setSetting(admin, key, String(used + 1))
    const a = [topic.keyword, topic.angle].filter(Boolean).join(' - ')
    const b = [match.doc.title, match.doc.keyword].filter(Boolean).join(' - ')
    const prompt = `Two travel blog topics. Would ONE page fully answer both, so that writing both would be duplicate content? Different questions about the same place (for example weather vs cost) are NOT the same.\nA: ${a}\nB: ${b}\nReturn ONLY minified JSON: {"same":true|false}`
    const r = await callAnthropic({ max_tokens: 60, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 15_000, feature: 'topic-meaning' })
    if (!r || !r.res.ok) return false
    const parsed = parseModelJson<{ same?: boolean }>(anthropicText(await r.res.json()))
    return parsed?.same === true
  } catch {
    return false
  }
}

export interface MeaningVerdict {
  reason: string
  match: MeaningMatch
  how: 'deterministic' | 'ai'
}

/** Compares a topic with the context. null = accept it. A match is returned (not applied): see rejectAsDuplicate. */
export async function judgeTopicMeaning(admin: SupabaseClient, topic: TopicText, ctx: MeaningContext, opts: { queueRowId?: string | null } = {}): Promise<MeaningVerdict | null> {
  try {
    if (isVetoedIn(ctx.vetoes, 'topic_meaning', topic.keyword)) return null
    const r = findSameMeaning(topic, ctx.docs, { excludeId: opts.queueRowId ?? null })
    if (!r.best || r.band === 'different') return null
    if (r.band === 'same') return { reason: duplicateReason(r.best, 'deterministic', ctx.now), match: r.best, how: 'deterministic' }
    if (ctx.aiEnabled && (await aiSaysSame(admin, topic, r.best, ctx.now))) return { reason: duplicateReason(r.best, 'ai', ctx.now), match: r.best, how: 'ai' }
    return null
  } catch {
    return null
  }
}

/** Applies a verdict: marks the queue row rejected with the reason (when there is one) and writes the decisions log line. Never throws. */
export async function rejectAsDuplicate(admin: SupabaseClient, topic: TopicText & { why?: string | null }, verdict: MeaningVerdict, opts: { queueRowId?: string | null; wasApproved?: boolean; where: string }): Promise<void> {
  try {
    let undo: { kind: 'topic-restore'; ref: string } | null = null
    if (opts.queueRowId && !blockIfDry('topic-status', `topic ${opts.queueRowId} -> rejected (${verdict.reason})`)) {
      const why = `${(topic.why ?? '').replace(/\s*\|\s*duplicate of [\s\S]*$/, '').trim()} | ${verdict.reason}`.replace(/^\s*\|\s*/, '')
      const { error } = await admin.from('blog_topic_queue').update({ status: 'rejected', why }).eq('id', opts.queueRowId)
      if (!error) undo = { kind: 'topic-restore', ref: `${opts.queueRowId}|${opts.wasApproved ? 'approved' : 'suggested'}` }
    }
    await appendDecisions(admin, [decision('topic_meaning', topic.keyword, `Skipped a topic (${opts.where})`, verdict.reason, undo)])
  } catch {
    // the topic is skipped either way; only the log line would be missing
  }
}

/** One call for a picker: null when the topic may go ahead, otherwise the reason it is a duplicate. The duplicate is rejected and logged
 * here (and added to the context so later candidates in the same pass see it), so the picker just moves on to the next one. */
export async function meaningRejection(admin: SupabaseClient, topic: TopicText & { why?: string | null }, ctx: MeaningContext | null, opts: { queueRowId?: string | null; wasApproved?: boolean; where: string }): Promise<string | null> {
  if (!ctx) return null
  const v = await judgeTopicMeaning(admin, topic, ctx, opts)
  if (!v) return null
  await rejectAsDuplicate(admin, topic, v, opts)
  // The rejected row must not count as an existing topic for the next candidate (two near-identical queued topics keep ONE of them).
  if (opts.queueRowId) ctx.docs = ctx.docs.filter((d) => d.id !== opts.queueRowId)
  return v.reason
}
