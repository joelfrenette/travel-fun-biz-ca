import { parseCardId } from '@/lib/today-cards'
import { cardActionsFor, healDay, parseHealCache, putHeal, TODAY_HEAL_KEY, type CardHealResult, type HealId } from '@/lib/today-card-actions'

// "Auto-heal" on ONE Today card. This file is only the rules around it (is the card allowed one, is today's answer already known,
// is automation paused) with every outside thing passed in, so scripts/check-today-actions.ts runs it offline with fake healers.
// The real repairs live in lib/today-heal-fns.ts and are the same capped, gated, undo-logged functions the site runs every day;
// nothing here adds a new kind of automatic action.

export interface HealStore {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

/** One repair for one card. `key` is the part of the card id after "kind:". It reports what happened; it never throws on purpose. */
export type Healer = (key: string, ctx: { now: Date }) => Promise<{ state: CardHealResult['state']; message: string }>

export interface HealCoreDeps {
  now: Date
  store: HealStore
  isPaused: () => Promise<boolean>
  healers: Partial<Record<HealId, Healer>>
}

export type HealOutcome = { ok: true; result: CardHealResult } | { ok: false; status: number; error: string }

/** Runs (or recalls) the Auto-heal of one card. One healer call at most; repeat presses on the same card the same day return the
 * stored answer without running anything. Pure apart from the injected functions. */
export async function runCardHeal(id: unknown, d: HealCoreDeps): Promise<HealOutcome> {
  const parsed = parseCardId(id)
  if (!parsed) return { ok: false, status: 400, error: 'That is not a card id.' }
  const actions = cardActionsFor(parsed.kind)
  if (!actions.canAutoHeal || !actions.healFn) return { ok: false, status: 400, error: 'This card has no safe automatic fix.' }
  const cardId = id as string
  const day = healDay(d.now)

  let cache = parseHealCache(await d.store.read().catch(() => null), day)
  const hit = cache.results[cardId]
  if (hit) return { ok: true, result: { ...hit, cached: true } }

  const at = d.now.toISOString()
  if (await d.isPaused().catch(() => true)) {
    return { ok: true, result: { state: 'skipped', message: 'Skipped: automation is paused (the kill switch is on), so nothing was repaired.', at } }
  }
  const healer = d.healers[actions.healFn]
  if (!healer) return { ok: true, result: { state: 'skipped', message: 'Skipped: this repair is not available right now.', at } }

  let result: CardHealResult
  try {
    const r = await healer(parsed.key, { now: d.now })
    result = { state: r.state, message: r.message, at }
  } catch (e) {
    result = { state: 'failed', message: `The repair failed: ${e instanceof Error ? e.message : 'unknown error'}`, at }
  }
  const next = putHeal(cache, cardId, result)
  if (next !== cache) {
    cache = next
    await d.store.write(JSON.stringify(cache)).catch(() => undefined)
  }
  return { ok: true, result }
}

export { TODAY_HEAL_KEY }
