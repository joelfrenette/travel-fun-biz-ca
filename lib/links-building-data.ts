// Server side of the Link building workspace: reads the saved task state and earned links from app_settings, the
// suppliers from published travel_packages, the affiliate partner names, and snapshots the public NAP surfaces.
// Every read fails open: a failed read gives an empty list and a note, never a thrown error and never a blank page.
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { officeInfo } from '@/content/footer'
import { translate } from '@/lib/i18n'
import { SMS_CONSENT_KEY } from '@/content/footer'
import { buildOrganizationJsonLd } from '@/lib/org-jsonld'
import { SITE_NAME, SITE_URL, absoluteUrl, priceOnRequestLine, site } from '@/lib/site'
import { GROUP_BLURBS, GROUP_LABELS, GROUP_ORDER, type LinkGroup, type LinkStatus } from '@/lib/link-targets'
import {
  EARNED_KEY, TASKS_KEY, allTargets, buildDrafts, checkNap, napBlock, napSummary, parseEarned, parseTaskState,
  serializeEarned, serializeTaskState, suggestPartnerTasks, type Draft, type EarnedLink, type Nap, type NapFinding, type NapSurface, type TaskStateMap,
} from '@/lib/link-building'
import type { DraftKind, Level } from '@/lib/link-targets'

export interface TaskViewDTO {
  id: string
  group: LinkGroup
  title: string
  how: string
  searchPhrase: string
  officialSite: string
  effort: Level
  value: Level
  needsNap: boolean
  askHolds: boolean
  ideaOnly: boolean
  draftKinds: DraftKind[]
  drafts: Draft[]
  status: LinkStatus
  note: string
  holds: boolean | null
}

export function siteNap(): Nap {
  return { name: SITE_NAME, addressLines: site.addressLines, phone: site.phone, url: SITE_URL }
}

/** The public places that show the name, address and phone, read from the same config the pages render from. */
export function buildNapSurfaces(): NapSurface[] {
  const ld = buildOrganizationJsonLd() as { name?: string; telephone?: string; address?: { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string } }
  const por = priceOnRequestLine()
  return [
    { surface: 'lib/site.ts (the source of truth)', name: site.name, phone: site.phone, street: site.addressLines[0] ?? '', locality: site.address.locality, region: site.address.region, postalCode: site.address.postalCode },
    { surface: 'Footer (content/footer.ts)', phone: officeInfo.phone, street: officeInfo.addressLines[0] ?? '', text: officeInfo.addressLines.join(' ') },
    { surface: 'JSON-LD TravelAgency (home page)', name: ld.name, phone: ld.telephone, street: ld.address?.streetAddress, locality: ld.address?.addressLocality, region: ld.address?.addressRegion, postalCode: ld.address?.postalCode },
    { surface: 'Contact form consent line (English)', text: translate('en', SMS_CONSENT_KEY).replace('{phone}', site.phone) },
    { surface: 'Contact form consent line (French)', text: translate('fr', SMS_CONSENT_KEY).replace('{phone}', site.phone) },
    { surface: 'Contact form consent line (Spanish)', text: translate('es', SMS_CONSENT_KEY).replace('{phone}', site.phone) },
    { surface: 'Price on request line (trip cards)', phone: por.phone, text: por.text },
  ]
}

export function napCheck(): { findings: NapFinding[]; total: number; bad: number } {
  const findings = checkNap(buildNapSurfaces(), {
    name: site.name, phone: site.phone, street: site.addressLines[0] ?? '', locality: site.address.locality, region: site.address.region, postalCode: site.address.postalCode,
  })
  return { findings, ...napSummary(findings) }
}

async function readSafe(admin: SupabaseClient, key: string): Promise<string | null> {
  try { return await getSetting(admin, key) } catch { return null }
}

export async function readEarned(admin: SupabaseClient): Promise<EarnedLink[]> {
  return parseEarned(await readSafe(admin, EARNED_KEY))
}

export async function readTaskState(admin: SupabaseClient): Promise<TaskStateMap> {
  return parseTaskState(await readSafe(admin, TASKS_KEY))
}

export async function writeTaskState(admin: SupabaseClient, map: TaskStateMap): Promise<{ error?: string }> {
  try { return await setSetting(admin, TASKS_KEY, serializeTaskState(map)) } catch (e) { return { error: e instanceof Error ? e.message : 'Could not save.' } }
}

export async function writeEarned(admin: SupabaseClient, items: EarnedLink[]): Promise<{ error?: string }> {
  try { return await setSetting(admin, EARNED_KEY, serializeEarned(items)) } catch (e) { return { error: e instanceof Error ? e.message : 'Could not save.' } }
}

async function readPartnerNames(admin: SupabaseClient): Promise<{ suppliers: string[]; affiliates: string[]; note?: string }> {
  const notes: string[] = []
  let suppliers: string[] = []
  let affiliates: string[] = []
  try {
    const { data, error } = await admin.from('travel_packages').select('supplier').eq('status', 'published').not('supplier', 'is', null).limit(500)
    if (error) notes.push('Could not read the suppliers on your published trips.')
    else suppliers = ((data ?? []) as { supplier: string | null }[]).map((r) => r.supplier ?? '').filter(Boolean)
  } catch { notes.push('Could not read the suppliers on your published trips.') }
  try {
    const { data, error } = await admin.from('affiliate_partners').select('name').neq('status', 'hidden').limit(200)
    if (!error) affiliates = ((data ?? []) as { name: string | null }[]).map((r) => r.name ?? '').filter(Boolean)
  } catch { /* the table may not exist yet: no suggestions from it */ }
  return { suppliers, affiliates, ...(notes.length ? { note: notes.join(' ') } : {}) }
}

export interface LinksView {
  site: { name: string; url: string; phone: string; addressLines: string[]; nap: string }
  groups: { group: LinkGroup; label: string; blurb: string; tasks: TaskViewDTO[] }[]
  earned: EarnedLink[]
  nap: { findings: NapFinding[]; total: number; bad: number }
  counts: { total: number; done: number; doing: number; skipped: number; todo: number }
  notes: string[]
}

export async function buildLinksView(admin: SupabaseClient): Promise<LinksView> {
  const notes: string[] = []
  const [state, earned, names] = await Promise.all([readTaskState(admin), readEarned(admin), readPartnerNames(admin)])
  if (names.note) notes.push(names.note)
  const nap = siteNap()
  const targets = allTargets(suggestPartnerTasks(names.suppliers, names.affiliates))
  const anchor = `${SITE_NAME}: hosted group trips and cruises`
  const tasks: TaskViewDTO[] = targets.map((t) => {
    const s = state[t.id]
    const drafts = t.drafts.flatMap((k) => buildDrafts(k, {
      ...nap,
      city: site.address.locality,
      linkUrl: t.group === 'social' ? absoluteUrl('/links') : absoluteUrl('/'),
      anchor,
      targetName: t.group === 'partners' ? t.title.replace(/^Ask /, '').replace(/ to link to your agent page$/, '') : t.title,
    }))
    return {
      id: t.id, group: t.group, title: t.title, how: t.how, searchPhrase: t.searchPhrase, officialSite: t.officialSite,
      effort: t.effort, value: t.value, needsNap: t.needsNap, askHolds: !!t.askHolds, ideaOnly: !!t.ideaOnly, draftKinds: t.drafts, drafts,
      status: s?.status ?? 'todo', note: s?.note ?? '', holds: t.askHolds ? (s?.holds ?? false) : null,
    }
  })
  const counted = tasks.filter((t) => !t.askHolds || t.holds)
  const counts = {
    total: counted.length,
    done: counted.filter((t) => t.status === 'done').length,
    doing: counted.filter((t) => t.status === 'doing').length,
    skipped: counted.filter((t) => t.status === 'skipped').length,
    todo: counted.filter((t) => t.status === 'todo').length,
  }
  return {
    site: { name: nap.name, url: nap.url, phone: nap.phone, addressLines: nap.addressLines, nap: napBlock(nap) },
    groups: GROUP_ORDER.map((g) => ({ group: g, label: GROUP_LABELS[g], blurb: GROUP_BLURBS[g], tasks: tasks.filter((t) => t.group === g) })).filter((g) => g.tasks.length),
    earned,
    nap: napCheck(),
    counts,
    notes,
  }
}

/** The ids the route accepts: every static task plus the partner tasks built from today's data. */
export async function knownTaskIds(admin: SupabaseClient): Promise<Set<string>> {
  const names = await readPartnerNames(admin)
  return new Set(allTargets(suggestPartnerTasks(names.suppliers, names.affiliates)).map((t) => t.id))
}
