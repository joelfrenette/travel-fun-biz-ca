import type { SupabaseClient } from '@supabase/supabase-js'
import { looksLikeInjection, type RawFeedItem } from '@/lib/news-feed'
import { ukCountryOf } from '@/lib/news-uk'
import { CA_ADVISORY_SOURCE_KEY, advisoryTitle, type AdvisoryMode } from '@/lib/country-advisory'
import { markCanadaChecked, writeCanadaEvent, writeUkEvent } from '@/lib/country-advisory-store'
import { enrollAdvisoryIfDue } from '@/lib/country-advisory-social'

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
