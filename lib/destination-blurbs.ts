import { supabase } from '@/integrations/supabase/client'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { callAnthropic, anthropicText, isAiConfigured } from '@/lib/ai-verify'

// Descriptive text for the destination/city/port a package is in (roadmap use case f267e278),
// split out from the image-auto-generation work now that it's done. One row per destination
// slug (public.destination_blurbs, migration 0014) - a blurb describes the place, not any one
// trip to it, so it's shared by every package at that destination.

export interface DestinationBlurb {
  slug: string
  destination: string
  blurb: string
  source: 'ai' | 'manual'
  updated_at: string
}

export async function getPublicBlurb(slug: string): Promise<DestinationBlurb | null> {
  const { data, error } = await supabase.from('destination_blurbs').select('*').eq('slug', slug).maybeSingle()
  if (error) {
    console.error('[destination-blurbs] fetch failed:', error.message)
    return null
  }
  return data
}

export async function getAllBlurbsAdmin(): Promise<DestinationBlurb[]> {
  const { data, error } = await getSupabaseAdmin().from('destination_blurbs').select('*')
  if (error) {
    console.error('[destination-blurbs] admin fetch failed:', error.message)
    return []
  }
  return data ?? []
}

export async function saveBlurb(slug: string, destination: string, blurb: string, source: 'ai' | 'manual'): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = blurb.trim()
  if (!trimmed) return { ok: false, error: 'Blurb cannot be empty.' }
  const { error } = await getSupabaseAdmin()
    .from('destination_blurbs')
    .upsert({ slug, destination, blurb: trimmed, source, updated_at: new Date().toISOString() })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deleteBlurb(slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await getSupabaseAdmin().from('destination_blurbs').delete().eq('slug', slug)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// A destination blurb is general travel-guide copy about a well-known place (Santorini, Tahiti,
// Croatia's coastline), not a claim about any specific trip - closer in kind to what a reputable
// guidebook would say than to lib/package-extract.ts's per-package fact grounding. It still
// carries real fabrication risk (a wrong "best time to visit" month, an invented landmark, a
// specific number that happens to be false), so the prompt keeps it deliberately general: no
// dates, prices, visa/entry rules, specific counts, or narrow factual claims a reader could act
// on and get burned by. An admin reviews and can hand-edit every word before it goes live.
const BLURB_PROMPT = (destination: string) => `Write a short, warm travel-guide style blurb (2-3 sentences, 40-70 words) about ${destination} as a vacation destination, for a Canadian travel agency's website. General knowledge only - the kind of description you'd find in a reputable guidebook's opening paragraph.

Rules: no specific numbers (no populations, distances, years, prices, or dates), no visa, currency or entry-requirement claims (those change and go stale), no invented landmark names you aren't confident are real and located there, no claim of a "best time to visit" month (seasons vary by traveler and go stale). Write about the general character of the place: its landscape, its typical vibe, what travelers usually go there for. Plain prose, no headings, no bullet points, no marketing superlatives like "unforgettable" or "of a lifetime". Return ONLY the blurb text, nothing else.`

export async function generateBlurb(destination: string): Promise<{ blurb: string; error: null } | { blurb: null; error: string }> {
  if (!isAiConfigured()) return { blurb: null, error: 'AI writing is not configured: set ANTHROPIC_API_KEY.' }
  const r = await callAnthropic({ max_tokens: 1000, messages: [{ role: 'user', content: BLURB_PROMPT(destination) }] }, { timeoutMs: 40_000 })
  if (!r) return { blurb: null, error: 'The AI did not answer in time. Try again.' }
  if (!r.res.ok) {
    const t = await r.res.text().catch(() => '')
    console.error('[destination-blurbs] anthropic error', r.res.status, t.slice(0, 300))
    return { blurb: null, error: `AI request failed (HTTP ${r.res.status}).` }
  }
  const text = anthropicText(await r.res.json()).trim()
  if (!text) return { blurb: null, error: 'The AI returned nothing. Try again.' }
  if (/\[[^\]]*\]|lorem ipsum|\btbd\b/i.test(text)) return { blurb: null, error: 'The AI draft contained placeholder text; discarded. Try again.' }
  return { blurb: text, error: null }
}
