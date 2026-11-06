import type { SupabaseClient } from '@supabase/supabase-js'
import { looksLikeInjection, type RawFeedItem } from '@/lib/news-feed'
import { ukCountryOf } from '@/lib/news-uk'
import { CA_ADVISORY_SOURCE_KEY, advisoryTitle, planBackfill, type AdvisoryMode, type BackfillInput, type BackfillSource, type CaEvent, type UkEvent } from '@/lib/country-advisory'
import { applyUsFeed, listAllAdvisories, markBackfillDone, markCanadaChecked, readBackfillDone, saveBackfillRows, writeCanadaEvent, writeUkEvent } from '@/lib/country-advisory-store'
import { parseUsAdvisoryFeed } from '@/lib/country-advisory'
import { enrollAdvisoryIfDue } from '@/lib/country-advisory-social'
import { pingIndexNow } from '@/lib/indexnow'
import { fetchUkTravelAdviceIndex, recentlyAttempted, recordAttempt } from '@/lib/country-advisory-uk-api'
import type { FetchDeps } from '@/lib/news-feed'

// Travel advisories: the DUAL WRITE called from the news ingest (lib/news-ingest.ts). The news posts are created exactly as before;
// this only also records the same advisory in country_advisories and country_advisory_log. Nothing here ever throws into the ingest,
// and with the mode 'off' none of it runs (the caller does not call it).

export interface AdvisoryIngestNote {
  mode: AdvisoryMode
  /** New log rows written. */
  logged: number
  /** Level changes among them. */
  levelChanges: number
  /** Countries whose stored Canadian level the snapshot confirmed (their "last checked" moved). */
  confirmed: number
  social: { enrolled: number; skipped: number; ceiling: number }
  /** One-time backfill results of THIS read (only a source that actually ran appears here). */
  backfill?: { source: BackfillSource; created: number; filled: number; skipped: number }[]
  /** Plain notes for Needs attention: a name that could not be matched, a write that failed. */
  notes: string[]
}

export const emptyAdvisoryNote = (mode: AdvisoryMode): AdvisoryIngestNote => ({ mode, logged: 0, levelChanges: 0, confirmed: 0, social: { enrolled: 0, skipped: 0, ceiling: 0 }, notes: [] })

const MAX_NOTES = 10
const addNote = (n: AdvisoryIngestNote, text: string) => {
  if (n.notes.length < MAX_NOTES && !n.notes.includes(text)) n.notes.push(text)
}

/** Canada: `changed` are the items the news state found changed this read, `snapshot` is every country in the file. */
export async function dualWriteCanada(
  admin: SupabaseClient,
  note: AdvisoryIngestNote,
  changed: RawFeedItem[],
  snapshot: RawFeedItem[],
  prevLevels: Record<string, string> | undefined,
  now: Date,
): Promise<void> {
  try {
    for (const i of changed) {
      if (!i.stateKey || !i.stateName || !i.stateLevel) continue
      const out = await writeCanadaEvent(
        admin,
        { iso: i.stateKey, name: i.stateName, level: i.stateLevel, description: i.summary, url: i.url, publishedAt: i.publishedAt, guid: i.guid },
        prevLevels && Object.prototype.hasOwnProperty.call(prevLevels, i.stateKey) ? prevLevels[i.stateKey] : null,
        now,
        looksLikeInjection,
      )
      if (!out.ok) {
        if (out.note) addNote(note, out.note)
        continue
      }
      if (out.logged) note.logged++
      if (out.levelChange) {
        note.levelChanges++
        const r = await enrollAdvisoryIfDue(
          admin,
          { countrySlug: out.levelChange.slug, title: advisoryTitle({ name: out.levelChange.name, ca_level: out.levelChange.to, ca_text: null, uk_text: null }), source: CA_ADVISORY_SOURCE_KEY, kind: 'level_change', mode: note.mode },
          now,
        )
        if (r === 'enrolled') note.social.enrolled++
        else if (r === 'ceiling') note.social.ceiling++
        else note.social.skipped++
      }
    }
    note.confirmed = await markCanadaChecked(admin, snapshot, now)
  } catch (e) {
    addNote(note, `travel advisories (Canada): ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected error'}`)
  }
}

/** US Department of State: the WHOLE feed text of one good read. A country with a page is updated when its entry changed and confirmed
 * when the feed repeats it; a country without a page gets one only for an entry newer than `maxAgeDays`. Never throws. The text is the
 * feed exactly as fetched (by lib/news-feed.ts fetchFeed, which respects robots.txt): nothing here fetches anything. */
export async function dualWriteUs(admin: SupabaseClient, note: AdvisoryIngestNote, feedText: string, now: Date, maxAgeDays: number): Promise<void> {
  try {
    const events = parseUsAdvisoryFeed(feedText)
    if (events.length === 0) {
      addNote(note, 'US travel advisories: the feed had no "Country - Level N" entries, so nothing was stored.')
      return
    }
    const r = await applyUsFeed(admin, events, now, maxAgeDays, looksLikeInjection)
    note.logged += r.logged
    note.levelChanges += r.levelChanges
    note.confirmed += r.confirmed
    for (const n of r.notes) addNote(note, n)
  } catch (e) {
    addNote(note, `travel advisories (US): ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected error'}`)
  }
}

/** The Canadian snapshot items as backfill events. An entry without a name or a level is left out (nothing is guessed). */
export function caBackfillEvents(snapshot: RawFeedItem[]): CaEvent[] {
  return snapshot
    .filter((i) => i.stateKey && i.stateName && i.stateLevel)
    .map((i) => ({ iso: i.stateKey as string, name: i.stateName as string, level: i.stateLevel as string, description: i.summary, url: i.url, publishedAt: i.publishedAt, guid: i.guid }))
}

/** The UK feed entries (already shaped: "UK travel advice update for X") as backfill events. A title with no country is left out. */
export function ukBackfillEvents(items: RawFeedItem[]): UkEvent[] {
  const out: UkEvent[] = []
  for (const i of items) {
    const country = ukCountryOf(i.title)
    if (country) out.push({ country, summary: i.summary, url: i.url, publishedAt: i.publishedAt, guid: i.guid })
  }
  return out
}

/** The ONE-TIME backfill: the first good read of a source's full list gives every country in it a row, not only the ones that
 * changed. Called from the news ingest after a good read, only while the advisory mode is log or on (the caller passes `note` only then).
 *
 * Safe by construction:
 *  - guarded: app_settings.country_advisories_backfill remembers each source once it has fully run; a source that is done is not read
 *    again, and an unreadable guard means "do nothing" (never "run");
 *  - additive: planBackfill leaves a country that already has data from this source exactly as it is, and creates nothing empty;
 *  - official wording only: the same level, quote, link and date the live dual write stores, never a made-up value;
 *  - quiet: no update-log row, no social enrolment, no news item (this function does not touch news_items or the posting ledger);
 *  - re-runnable: if it fails half way the guard is not set, and the next read does the rest without touching what is already saved.
 * Never throws. */
export async function backfillAdvisories(admin: SupabaseClient, note: AdvisoryIngestNote, input: BackfillInput, now: Date): Promise<void> {
  try {
    const guard = await readBackfillDone(admin)
    if (guard.error) {
      addNote(note, `travel advisories (${input.source} backfill): could not read the backfill guard, so nothing was backfilled.`)
      return
    }
    if (guard.done[input.source]) return
    if (input.events.length === 0) return
    const { rows: existing, hasUsColumns } = await listAllAdvisories(admin)
    if (input.source === 'us' && !hasUsColumns) {
      addNote(note, 'US travel advisories: run migration 0064_country_advisories_us.sql, then the US entries will be backfilled.')
      return
    }
    const plan = planBackfill(input, existing, now.toISOString(), looksLikeInjection)
    for (const n of plan.notes) addNote(note, n)
    const saved = await saveBackfillRows(admin, plan.rows, hasUsColumns, now)
    if (saved.error) {
      addNote(note, `travel advisories (${input.source} backfill): ${saved.error}`)
      return
    }
    // New country pages are announced to IndexNow (Bing and others) the moment they exist; a failed ping never blocks the backfill.
    if (plan.created > 0) {
      const paths = plan.rows.slice(0, 99).map((r) => `/travel-advisories/${r.slug}`)
      await pingIndexNow(['/travel-advisories', ...paths]).catch(() => undefined)
    }
    const marked = await markBackfillDone(admin, input.source, now)
    if (marked.error) addNote(note, `travel advisories (${input.source} backfill): saved the countries but could not save the guard (${marked.error.slice(0, 80)}); a re-run changes nothing.`)
    ;(note.backfill ??= []).push({ source: input.source, created: plan.created, filled: plan.filled, skipped: plan.skipped })
  } catch (e) {
    addNote(note, `travel advisories (${input.source} backfill): ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected error'}`)
  }
}

/** The one-time UK backfill from the GOV.UK Content API (see lib/country-advisory-uk-api.ts): every country, not only the 20 the Atom feed
 * lists. Guarded by the 'uk-full-backfill' key of the same app_settings guard; an unreadable guard means do nothing; a refused or failed
 * attempt is not repeated for 6 hours; one request plus robots.txt per run, 1 second apart. Additive and quiet like every backfill (a
 * country that already has a UK line is left alone; no log row, no social, no news item). Never throws. */
export async function ukFullBackfill(admin: SupabaseClient, note: AdvisoryIngestNote, deps: FetchDeps, now: Date, pauseMs?: number): Promise<void> {
  try {
    const guard = await readBackfillDone(admin)
    if (guard.error) {
      addNote(note, 'travel advisories (UK full backfill): could not read the backfill guard, so nothing was backfilled.')
      return
    }
    if (guard.done['uk-full-backfill']) return
    if (await recentlyAttempted(admin, now.getTime())) return
    if (!(await recordAttempt(admin, now))) {
      addNote(note, 'travel advisories (UK full backfill): could not save the attempt time, so GOV.UK was not read.')
      return
    }
    const r = await fetchUkTravelAdviceIndex(deps, pauseMs)
    if (!r.ok) {
      addNote(note, `travel advisories (UK full backfill): ${r.error.slice(0, 140)}; it will be tried again later.`)
      return
    }
    await backfillAdvisories(admin, note, { source: 'uk-full-backfill', events: r.events }, now)
  } catch (e) {
    addNote(note, `travel advisories (UK full backfill): ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected error'}`)
  }
}

/** UK: one shaped UK item ("UK travel advice update for X"). A title that does not give a country is noted and skipped, not guessed. */
export async function dualWriteUk(admin: SupabaseClient, note: AdvisoryIngestNote, item: RawFeedItem, now: Date): Promise<void> {
  try {
    const country = ukCountryOf(item.title)
    if (!country) {
      addNote(note, `UK advice item "${item.title.slice(0, 60)}" has no country name, so it was not stored on a country page.`)
      return
    }
    const out = await writeUkEvent(admin, { country, summary: item.summary, url: item.url, publishedAt: item.publishedAt, guid: item.guid }, now, looksLikeInjection)
    if (!out.ok) {
      if (out.note) addNote(note, out.note)
      return
    }
    if (out.logged) note.logged++
  } catch (e) {
    addNote(note, `travel advisories (UK): ${e instanceof Error ? e.message.slice(0, 120) : 'unexpected error'}`)
  }
}
