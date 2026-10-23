// "Where will posts really go?" for the Posting card. Pure: it takes what the posting API already read and returns the list of networks
// that will actually receive a post, plus, for every mainstream network that will not, the plain reason.
//
// Why this exists: the setting distribution_platforms is the Upload-Post list ONLY. While GoHighLevel is the provider it is ignored
// (lib/social-provider.ts: the live list is the platforms of the ticked ghl_accounts), so it can say "bluesky" while four other networks
// are posted to. The card must show the effective list, not that setting.

import { MEDIA_NETWORKS } from '@/lib/social-provider'

/** The line the Posting card always shows. */
export const NO_TEXT_ONLY_NOTE = 'No text-only posts: networks that cannot take an image are skipped.'
/** X is the same network as "twitter". Reddit and any other text-only network are not media networks, so they are never listed. */
const isMediaNetwork = (p: string): boolean => MEDIA_NETWORKS.includes(p)

export const MAINSTREAM_NETWORKS = ['facebook', 'instagram', 'x', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'threads'] as const

const LABEL: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads', bluesky: 'Bluesky', google: 'Google Business', reddit: 'Reddit' }
export const networkLabel = (p: string) => LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1)

/** One spelling per network ("twitter" is X). */
export function normalizeNetwork(p: string): string {
  const v = p.trim().toLowerCase()
  return v === 'twitter' ? 'x' : v
}

export interface EffectiveInput {
  provider: 'upload-post' | 'ghl'
  ghl: {
    configured: boolean
    missing: string[]
    /** Every account GoHighLevel listed (empty with `error` set when the list could not be read). */
    accounts: { id: string; platform: string; name?: string; active: boolean; expired: boolean }[]
    /** The accounts ticked in the card (ghl_accounts). */
    selected: { id: string; platform: string; name?: string }[]
    error: string | null
  }
  upload: {
    configured: boolean
    profilesError: string | null
    profiles: { username: string; accounts: { platform: string; status?: string }[] }[]
    selectedProfile: string
    /** distribution_platforms */
    selectedPlatforms: string[]
  }
}

export interface EffectiveNetworks {
  provider: 'upload-post' | 'ghl'
  /** Networks that will receive a post, in display order. */
  networks: string[]
  /** Mainstream networks that will not, each with the reason and where to fix it. */
  missing: { platform: string; reason: string }[]
  /** Things worth knowing about the list (a stale setting that is ignored, a network that takes only some kinds of post). */
  notes: string[]
}

const order = (list: string[]) => [...list].sort((a, b) => {
  const ia = MAINSTREAM_NETWORKS.indexOf(a as (typeof MAINSTREAM_NETWORKS)[number])
  const ib = MAINSTREAM_NETWORKS.indexOf(b as (typeof MAINSTREAM_NETWORKS)[number])
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
})

function ghlResult(i: EffectiveInput): EffectiveNetworks {
  const { ghl } = i
  const notes: string[] = []
  const stale = i.upload.selectedPlatforms.map(normalizeNetwork).filter(Boolean)
  if (stale.length) notes.push(`The old Upload-Post list (${stale.map(networkLabel).join(', ')}) is ignored while GoHighLevel is the provider. Only the accounts ticked below are posted to.`)

  if (!ghl.configured) {
    const reason = `GoHighLevel is not set up yet (needs ${ghl.missing.join(', ') || 'its Vercel settings'})`
    return { provider: 'ghl', networks: [], missing: MAINSTREAM_NETWORKS.map((platform) => ({ platform, reason })), notes }
  }

  const listed = ghl.error ? null : ghl.accounts
  const reasonFor = new Map<string, string>()
  const posting = new Set<string>()
  for (const s of ghl.selected) {
    const p = normalizeNetwork(s.platform)
    const live = listed?.find((a) => a.id === s.id)
    if (listed && !live) {
      reasonFor.set(p, `${networkLabel(p)} is ticked but that account is no longer in GoHighLevel: reconnect it in GoHighLevel, then tick it again`)
    } else if (live && (live.expired || !live.active)) {
      reasonFor.set(p, `${networkLabel(p)}'s connection in GoHighLevel ${live.expired ? 'has expired' : 'is inactive'}: reconnect it in GoHighLevel (Social Planner)`)
    } else {
      posting.add(p)
      reasonFor.delete(p)
    }
  }

  const missing: EffectiveNetworks['missing'] = []
  for (const p of MAINSTREAM_NETWORKS) {
    if (posting.has(p)) continue
    const bad = reasonFor.get(p)
    if (bad) {
      missing.push({ platform: p, reason: bad })
      continue
    }
    if (!listed) {
      missing.push({ platform: p, reason: `${networkLabel(p)} is not ticked, and GoHighLevel's account list could not be read right now (${ghl.error})` })
      continue
    }
    const there = listed.filter((a) => normalizeNetwork(a.platform) === p)
    if (there.some((a) => a.active && !a.expired)) missing.push({ platform: p, reason: `${networkLabel(p)} is connected in GoHighLevel but not ticked: tick it above` })
    else if (there.length) missing.push({ platform: p, reason: `${networkLabel(p)}'s connection in GoHighLevel ${there.some((a) => a.expired) ? 'has expired' : 'is inactive'}: reconnect it in GoHighLevel (Social Planner)` })
    else missing.push({ platform: p, reason: `${networkLabel(p)}: not connected in GoHighLevel. Connect it in GoHighLevel (Social Planner), then tick it above` })
  }
  if (posting.has('tiktok')) notes.push('TikTok through GoHighLevel takes videos only, so image posts skip it.')
  notes.push(NO_TEXT_ONLY_NOTE)
  return { provider: 'ghl', networks: order([...posting].filter(isMediaNetwork)), missing, notes }
}

function uploadResult(i: EffectiveInput): EffectiveNetworks {
  const { upload } = i
  const notes: string[] = []
  const ticked = i.ghl.selected.map((s) => normalizeNetwork(s.platform))
  if (ticked.length) notes.push(`The GoHighLevel accounts ticked (${[...new Set(ticked)].map(networkLabel).join(', ')}) are ignored while Upload-Post is the provider.`)

  const everyone = (reason: string): EffectiveNetworks => ({ provider: 'upload-post', networks: [], missing: MAINSTREAM_NETWORKS.map((platform) => ({ platform, reason })), notes })
  if (!upload.configured) return everyone('UPLOAD_POST_API_KEY is not set in Vercel')
  if (!upload.selectedProfile) return everyone('no Upload-Post profile is chosen yet')

  const chosen = [...new Set(upload.selectedPlatforms.map(normalizeNetwork).filter(Boolean))]
  const profile = upload.profiles.find((p) => p.username === upload.selectedProfile)
  if (!profile) {
    // The profile list could not be checked, so what is saved is all there is to go on.
    notes.push(upload.profilesError ? `Upload-Post could not be checked right now (${upload.profilesError}), so this is the saved list, not a confirmed one.` : `The saved profile "${upload.selectedProfile}" is not in your Upload-Post list.`)
    notes.push(NO_TEXT_ONLY_NOTE)
    return { provider: 'upload-post', networks: order(chosen.filter(isMediaNetwork)), missing: MAINSTREAM_NETWORKS.filter((p) => !chosen.includes(p)).map((platform) => ({ platform, reason: `${networkLabel(platform)} is not ticked` })), notes }
  }

  const accounts = profile.accounts.map((a) => ({ p: normalizeNetwork(a.platform), bad: a.status === 'needs reconnect' }))
  const networks = chosen.filter((p) => isMediaNetwork(p) && accounts.some((a) => a.p === p && !a.bad))
  notes.push(NO_TEXT_ONLY_NOTE)
  const missing: EffectiveNetworks['missing'] = []
  for (const p of MAINSTREAM_NETWORKS) {
    if (networks.includes(p)) continue
    const acct = accounts.find((a) => a.p === p)
    if (!acct) missing.push({ platform: p, reason: `${networkLabel(p)}: not connected in Upload-Post. Press "Connect accounts", then tick it` })
    else if (acct.bad) missing.push({ platform: p, reason: `${networkLabel(p)} needs to be reconnected in Upload-Post` })
    else missing.push({ platform: p, reason: `${networkLabel(p)} is connected in Upload-Post but not ticked: tick it above` })
  }
  return { provider: 'upload-post', networks: order(networks), missing, notes }
}

/** The networks that will actually receive posts, and why each missing mainstream network will not. Pure. */
export function effectiveNetworks(i: EffectiveInput): EffectiveNetworks {
  return i.provider === 'ghl' ? ghlResult(i) : uploadResult(i)
}

/** One plain sentence for the top of the card. Pure. */
export function describeEffective(e: EffectiveNetworks): string {
  const via = e.provider === 'ghl' ? 'GoHighLevel' : 'Upload-Post'
  return e.networks.length ? `Posts go to ${e.networks.map(networkLabel).join(', ')} through ${via}.` : `Posts go nowhere right now (through ${via}).`
}
