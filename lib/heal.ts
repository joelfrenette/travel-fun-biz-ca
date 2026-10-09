import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { submitLeadToGoHighLevel, subscribeNewsletterToGoHighLevel } from '@/lib/gohighlevel'

// Self-healing: the few repairs that are provably safe to do without asking, run once per pipeline
// pass. Everything else that goes wrong is reported (Needs attention, the alert email and the daily
// brief) with plain steps instead. What is deliberately NOT healed automatically: a post that failed
// on a social network (re-sending is a public post), and a video whose render request timed out
// (it may already have been charged). Each repair is logged so the daily brief can say what it fixed.
const HEAL_LOG_KEY = 'selfheal_log'
const MAX_LOG = 60
const MAX_LEAD_TRIES = 3

export interface HealEntry {
  at: string
  text: string
}

export async function readHealLog(admin: SupabaseClient): Promise<HealEntry[]> {
  try {
    const list = JSON.parse((await getSetting(admin, HEAL_LOG_KEY)) ?? '[]')
    return Array.isArray(list) ? (list as HealEntry[]) : []
  } catch {
    return []
  }
}

async function logHeal(admin: SupabaseClient, texts: string[]): Promise<void> {
  if (!texts.length) return
  const at = new Date().toISOString()
  const list = await readHealLog(admin)
  await setSetting(admin, HEAL_LOG_KEY, JSON.stringify([...list, ...texts.map((text) => ({ at, text }))].slice(-MAX_LOG)))
}

interface LeadRow {
  id: string
  name: string
  email: string
  phone: string | null
  package: string | null
  travel_date: string | null
  travelers: string | null
  message: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  page_path: string | null
  ghl_error: string | null
}

/** Sends leads and newsletter signups that were saved here but never reached GoHighLevel, a few
 * minutes after they were saved (so a send still in progress is left alone), up to 3 tries each. */
async function healLeads(admin: SupabaseClient): Promise<string[]> {
  const done: string[] = []
  const { data } = await admin
    .from('leads')
    .select('id, name, email, phone, package, travel_date, travelers, message, utm_source, utm_medium, utm_campaign, utm_content, page_path, ghl_error')
    .eq('forwarded_to_ghl', false)
    .lt('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
    .gt('created_at', new Date(Date.now() - 48 * 3_600_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(5)
  for (const row of (data ?? []) as LeadRow[]) {
    const tries = Number(/^\[retry (\d+)\]/.exec(row.ghl_error ?? '')?.[1] ?? 0)
    if (/^\[gave up\]/.test(row.ghl_error ?? '')) continue
    if (tries >= MAX_LEAD_TRIES) {
      await admin.from('leads').update({ ghl_error: `[gave up] ${row.ghl_error ?? ''}`.slice(0, 300) }).eq('id', row.id)
      continue
    }
    const attribution = { utm_source: row.utm_source ?? undefined, utm_medium: row.utm_medium ?? undefined, utm_campaign: row.utm_campaign ?? undefined, utm_content: row.utm_content ?? undefined, page_path: row.page_path ?? undefined }
    const isNewsletter = row.package === 'Newsletter signup'
    const deals = (row.message ?? '').replace(/^Deal interests:\s*/i, '').split(',').map((d) => d.trim()).filter(Boolean)
    const result = isNewsletter
      ? await subscribeNewsletterToGoHighLevel({ fullName: row.name, email: row.email, phone: row.phone ?? '', deals: deals.length ? deals : ['general'], attribution })
      : await submitLeadToGoHighLevel({ name: row.name, email: row.email, phone: row.phone ?? undefined, package: row.package ?? 'Website', travelDate: row.travel_date ?? undefined, travelers: row.travelers ?? undefined, message: row.message ?? undefined, attribution })
    if (result.ok) {
      await admin.from('leads').update({ forwarded_to_ghl: true, ghl_error: null }).eq('id', row.id)
      done.push(`Sent a saved ${isNewsletter ? 'newsletter signup' : 'lead'} to GoHighLevel on try ${tries + 1}.`)
    } else {
      await admin.from('leads').update({ ghl_error: `[retry ${tries + 1}] ${result.error}`.slice(0, 300) }).eq('id', row.id)
    }
  }
  return done
}

/** A video that Shotstack turned away as busy (429/503) is safe to try once more an hour later: the
 * request was refused, so nothing was rendered or charged. Anything else stays for a person. */
async function healVideos(admin: SupabaseClient): Promise<string[]> {
  const done: string[] = []
  const { data } = await admin
    .from('content_pipeline')
    .select('slug, attempts, last_error')
    .eq('video_stage', 'failed')
    .lt('updated_at', new Date(Date.now() - 60 * 60_000).toISOString())
    .gt('updated_at', new Date(Date.now() - 24 * 3_600_000).toISOString())
    .limit(5)
  for (const row of (data ?? []) as { slug: string; attempts: Record<string, number> | null; last_error: string | null }[]) {
    const attempts = { ...(row.attempts ?? {}) }
    if (attempts.healed) continue
    if (!/\b(429|503)\b|too many requests|service unavailable/i.test(row.last_error ?? '')) continue
    delete attempts.video
    attempts.healed = 1
    const { error } = await admin.from('content_pipeline').update({ video_stage: 'pending', attempts, last_error: null, updated_at: new Date().toISOString() }).eq('slug', row.slug).eq('video_stage', 'failed')
    if (!error) done.push(`Tried the "${row.slug}" video again after Shotstack said it was busy.`)
  }
  return done
}

/** Runs every safe repair. Never throws; returns what it fixed. */
export async function selfHeal(admin: SupabaseClient): Promise<string[]> {
  const fixed: string[] = []
  for (const heal of [healLeads, healVideos]) {
    try {
      fixed.push(...(await heal(admin)))
    } catch {
      // one repair failing must never stop the next, or the pipeline
    }
  }
  await logHeal(admin, fixed).catch(() => undefined)
  return fixed
}
