import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { CATEGORIES, type Category, type PlaybookItem } from '@/lib/seo-playbook'
import type { TickState } from '@/lib/seo-playbook'

// The two things the owner writes on the SEO and GEO Manager page, both kept in app_settings and both bounded:
//   seo_playbook_state   a tick box and a short note per item
//   seo_playbook_custom  tips pasted in from influencers, shown in the list as manual items
// Pure functions first (tested offline), thin database helpers last. Reads fail open: a failed read gives an empty list.

export const STATE_KEY = 'seo_playbook_state'
export const CUSTOM_KEY = 'seo_playbook_custom'
export const MAX_STATE = 500
export const MAX_NOTE = 300
export const MAX_CUSTOM = 100
export const MAX_TITLE = 120
export const MAX_TEXT = 1500
export const MAX_SOURCE_NAME = 60
export const MAX_LINK = 300

// Characters that should never be stored: control characters except tab, newline and carriage return.
// Built from code points so no control character sits in this source file.
const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g')
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CONTROL_RE, '').trim().slice(0, max) : '')

// ---------------------------------------------------------------- ticks and notes

export type TickMap = Record<string, TickState>

export function parseTicks(raw: string | null | undefined): TickMap {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: TickMap = {}
    for (const [id, v] of Object.entries(p as Record<string, unknown>)) {
      if (Object.keys(out).length >= MAX_STATE) break
      if (!v || typeof v !== 'object' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) continue
      const o = v as Record<string, unknown>
      const entry: TickState = { done: o.done === true }
      const note = clean(o.note, MAX_NOTE)
      if (note) entry.note = note
      if (typeof o.at === 'string') entry.at = o.at.slice(0, 40)
      out[id] = entry
    }
    return out
  } catch {
    return {}
  }
}

export function serializeTicks(map: TickMap): string {
  return JSON.stringify(map)
}

/** Apply one change. The id must be a known item (built-in or custom). An entry with nothing left in it is dropped. */
export function applyTick(map: TickMap, id: unknown, patch: { done?: unknown; note?: unknown }, known: ReadonlySet<string>, nowIso: string): { map: TickMap } | { error: string } {
  if (typeof id !== 'string' || !known.has(id)) return { error: 'Unknown item.' }
  const next: TickMap = { ...map }
  const cur: TickState = { ...(next[id] ?? { done: false }) }
  if (patch.done !== undefined) {
    if (typeof patch.done !== 'boolean') return { error: 'done must be true or false.' }
    cur.done = patch.done
    cur.at = nowIso
  }
  if (patch.note !== undefined) {
    if (typeof patch.note !== 'string') return { error: 'The note must be text.' }
    if (patch.note.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` }
    const note = clean(patch.note, MAX_NOTE)
    if (note) cur.note = note
    else delete cur.note
  }
  if (!cur.done && !cur.note) delete next[id]
  else next[id] = cur
  if (Object.keys(next).length > MAX_STATE) return { error: 'Too many saved ticks.' }
  return { map: next }
}

// ---------------------------------------------------------------- pasted tips

export interface CustomTip {
  id: string
  title: string
  category: Category
  sourceName: string
  text: string
  link: string
  impact: 1 | 2 | 3 | 4 | 5
  createdAt: string
}

export function parseCustom(raw: string | null | undefined): CustomTip[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as unknown
    if (!Array.isArray(p)) return []
    const out: CustomTip[] = []
    for (const v of p) {
      if (out.length >= MAX_CUSTOM) break
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      const id = typeof o.id === 'string' && /^tip-[a-z0-9-]{4,40}$/.test(o.id) ? o.id : ''
      const title = clean(o.title, MAX_TITLE)
      const text = clean(o.text, MAX_TEXT)
      const category = (CATEGORIES as readonly string[]).includes(o.category as string) ? (o.category as Category) : null
      if (!id || !title || !text || !category) continue
      const impact = [1, 2, 3, 4, 5].includes(o.impact as number) ? (o.impact as CustomTip['impact']) : 3
      out.push({ id, title, text, category, impact, sourceName: clean(o.sourceName, MAX_SOURCE_NAME), link: safeLink(o.link), createdAt: typeof o.createdAt === 'string' ? o.createdAt.slice(0, 40) : '' })
    }
    return out
  } catch {
    return []
  }
}

export function serializeCustom(tips: CustomTip[]): string {
  return JSON.stringify(tips.slice(0, MAX_CUSTOM))
}

function safeLink(v: unknown): string {
  const s = clean(v, MAX_LINK)
  if (!s) return ''
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : ''
  } catch {
    return ''
  }
}

export interface TipInput {
  title?: unknown
  category?: unknown
  sourceName?: unknown
  text?: unknown
  link?: unknown
  impact?: unknown
}

export function validateTip(input: TipInput): { value: Omit<CustomTip, 'id' | 'createdAt'> } | { error: string } {
  const title = clean(input.title, MAX_TITLE + 1)
  if (!title) return { error: 'Give the tip a title.' }
  if (title.length > MAX_TITLE) return { error: `Keep the title under ${MAX_TITLE} characters.` }
  const text = clean(input.text, MAX_TEXT + 1)
  if (!text) return { error: 'Paste the tip text.' }
  if (text.length > MAX_TEXT) return { error: `Keep the tip under ${MAX_TEXT} characters.` }
  if (!(CATEGORIES as readonly string[]).includes(input.category as string)) return { error: 'Pick a category.' }
  const sourceName = clean(input.sourceName, MAX_SOURCE_NAME + 1)
  if (!sourceName) return { error: 'Say who the tip is from.' }
  if (sourceName.length > MAX_SOURCE_NAME) return { error: `Keep the name under ${MAX_SOURCE_NAME} characters.` }
  let link = ''
  if (typeof input.link === 'string' && input.link.trim()) {
    link = safeLink(input.link)
    if (!link) return { error: 'The link must start with http:// or https://.' }
  }
  const impactNum = input.impact === undefined || input.impact === '' ? 3 : Number(input.impact)
  if (![1, 2, 3, 4, 5].includes(impactNum)) return { error: 'Impact is 1 to 5.' }
  return { value: { title, text, category: input.category as Category, sourceName, link, impact: impactNum as CustomTip['impact'] } }
}

export function addTip(list: CustomTip[], input: TipInput, id: string, nowIso: string): { tips: CustomTip[] } | { error: string } {
  if (list.length >= MAX_CUSTOM) return { error: `You can keep up to ${MAX_CUSTOM} pasted tips. Delete one first.` }
  const v = validateTip(input)
  if ('error' in v) return v
  return { tips: [...list, { ...v.value, id, createdAt: nowIso }] }
}

/** A pasted tip as a list item: always a manual item, tagged with who it came from. */
export function tipToItem(t: CustomTip): PlaybookItem {
  return {
    id: t.id,
    title: t.title,
    category: t.category,
    impact: t.impact,
    effort: 2,
    automation: 'manual',
    verify: { kind: 'manual' },
    why: `A tip you added from ${t.sourceName || 'an influencer'}.`,
    how: [t.text, ...(t.link ? [`Source: ${t.link}`] : [])],
    appliesTo: 'all auto-blog sites',
    source: `influencer:${t.sourceName}`,
  }
}

// ---------------------------------------------------------------- database helpers (fail open on read)

async function readRaw(admin: SupabaseClient, key: string): Promise<string | null> {
  try {
    return await getSetting(admin, key)
  } catch {
    return null
  }
}

export async function readTicks(admin: SupabaseClient): Promise<TickMap> {
  return parseTicks(await readRaw(admin, STATE_KEY))
}
export async function readCustom(admin: SupabaseClient): Promise<CustomTip[]> {
  return parseCustom(await readRaw(admin, CUSTOM_KEY))
}
export async function writeTicks(admin: SupabaseClient, map: TickMap): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, STATE_KEY, serializeTicks(map))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not save.' }
  }
}
export async function writeCustom(admin: SupabaseClient, tips: CustomTip[]): Promise<{ error?: string }> {
  try {
    return await setSetting(admin, CUSTOM_KEY, serializeCustom(tips))
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not save.' }
  }
}
