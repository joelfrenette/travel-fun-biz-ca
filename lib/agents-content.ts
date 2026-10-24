import { agentPath, firstName, monthLabel, publicCertifications, type PublicAgent } from '@/lib/agents'
import { ungroundedNumbers } from '@/lib/hook-styles'

// People content drafts (pure). Everything here is built ONLY from the agent's own supplied, consented profile:
// no new facts, no numbers that are not in the profile, no amounts, no unverified certifications. Every result is a DRAFT
// for a human to approve; nothing here publishes anything.

export type DraftKind = 'welcome_post' | 'social_caption' | 'aotm_post' | 'aotm_caption'

export interface ContentDraft {
  kind: DraftKind
  title: string
  body: string
}

/** The facts a draft may use. Built from a PublicAgent, so an agent who is not publicly visible has no facts at all. */
export function profileFacts(a: PublicAgent): string {
  const certs = publicCertifications(a.certifications)
  const lines = [
    `Name: ${a.display_name}`,
    `Page: ${agentPath(a.slug)}`,
    a.headline ? `Headline: ${a.headline}` : '',
    a.bio ? `Bio: ${a.bio}` : '',
    a.specialties.length ? `Specialties: ${a.specialties.join(', ')}` : '',
    a.years_experience !== null ? `Years of experience: ${a.years_experience}` : '',
    a.languages.length ? `Languages: ${a.languages.join(', ')}` : '',
    a.home_city ? `Based in: ${a.home_city}` : '',
    certs.length ? `Verified certifications: ${certs.map((c) => c.name).join(', ')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function welcomePost(a: PublicAgent): ContentDraft {
  const f = firstName(a.display_name)
  const parts: string[] = []
  parts.push(`${a.display_name} is one of the travel specialists at TravelFunBiz.${a.headline ? ` ${a.headline.replace(/[.!]+$/, '')}.` : ''}`)
  if (a.specialties.length) parts.push(`${f}'s specialties: ${list(a.specialties)}.`)
  if (a.years_experience !== null && a.years_experience > 0) parts.push(`${f} has ${a.years_experience} years of experience in travel.`)
  if (a.languages.length) parts.push(`${f} speaks ${list(a.languages)}.`)
  const certs = publicCertifications(a.certifications)
  if (certs.length) parts.push(`Verified certifications: ${list(certs.map((c) => c.name))}.`)
  if (a.bio) parts.push(a.bio)
  parts.push(`Want to plan a trip? Send an enquiry through the website and our office will connect you with the right specialist. Read more about ${f} at ${agentPath(a.slug)}.`)
  return { kind: 'welcome_post', title: `Meet ${a.display_name}, travel specialist`, body: parts.join('\n\n') }
}

export function socialCaption(a: PublicAgent): ContentDraft {
  const f = firstName(a.display_name)
  const bits = [`Meet ${a.display_name}, one of our travel specialists.`]
  if (a.specialties.length) bits.push(`${f} knows ${list(a.specialties.slice(0, 3))}.`)
  if (a.years_experience !== null && a.years_experience > 0) bits.push(`${a.years_experience} years in travel.`)
  bits.push(`Say hello and start planning: travelfunbiz.ca${agentPath(a.slug)}`)
  return { kind: 'social_caption', title: `Caption: ${a.display_name}`, body: bits.join(' ') }
}

export function aotmPost(a: PublicAgent, month: string, blurb: string | null): ContentDraft {
  const f = firstName(a.display_name)
  const parts = [`${a.display_name} is our travel specialist of the month for ${monthLabel(month)}.`]
  if (blurb && blurb.trim()) parts.push(blurb.trim())
  if (a.specialties.length) parts.push(`${f}'s specialties: ${list(a.specialties)}.`)
  parts.push(`Meet ${f} at ${agentPath(a.slug)}. To plan a trip, send an enquiry through the website and our office will match you with the right specialist.`)
  return { kind: 'aotm_post', title: `${a.display_name} is our specialist of the month`, body: parts.join('\n\n') }
}

export function aotmCaption(a: PublicAgent, month: string, blurb: string | null): ContentDraft {
  const f = firstName(a.display_name)
  const bits = [`${a.display_name} is our travel specialist of the month for ${monthLabel(month)}.`]
  if (blurb && blurb.trim()) bits.push(blurb.trim().split(/(?<=[.!?])\s/)[0])
  bits.push(`Meet ${f}: travelfunbiz.ca${agentPath(a.slug)}`)
  return { kind: 'aotm_caption', title: `Caption: ${a.display_name}, specialist of the month`, body: bits.join(' ') }
}

/** Numbers in a draft that the profile does not contain (should always be empty; checked before queueing). */
export function ungroundedInDraft(draft: ContentDraft, a: PublicAgent, extra = ''): string[] {
  return ungroundedNumbers(draft.body, `${profileFacts(a)}\n${extra}`)
}

/** The blog-queue idea for a welcome / agent-of-the-month post. The composer is told to use only these facts. */
export function toTopicIdea(draft: ContentDraft, a: PublicAgent) {
  return {
    angle: `${draft.title}. Write a short, warm profile post. Use ONLY these facts about the person and add nothing else (no invented trips, clients, numbers or credentials):\n${profileFacts(a)}`,
    keyword: `${a.display_name} travel specialist`,
    why: 'People content: a specialist was published or named agent of the month. Needs human approval before it is written.',
    source: 'agent-profile',
  }
}
