// DRAFT - pending Joel's CASL review. Do not switch the "Instant lead reply" setting on until this wording is approved.
//
// ONE place for every word of the acknowledgement email a lead gets right after submitting a form
// (lib/lead-ack.ts sends it; the setting `lead_ack_email` is OFF by default). Edit the text here only.
//
// Rules this copy follows: no promise of a response time, no marketing offer (it only confirms the message
// arrived), our identity + phone + postal address in the footer, no em dashes. {firstName} is replaced with the
// lead's first name when it looks like a real name, otherwise "there".
import { site } from '@/lib/site'

export const LEAD_ACK_SUBJECT = 'We got your message'

/** Body paragraphs, in order. {firstName} is filled in. */
export const LEAD_ACK_PARAGRAPHS: string[] = [
  'Hi {firstName},',
  `Thanks for getting in touch with ${site.name}. This is a quick note to confirm your message reached us.`,
  'A travel advisor will read it and reply to you personally by email or phone.',
  `If you would like to talk sooner, you can call or text us at ${site.phone}.`,
]

/** Sign-off line. */
export const LEAD_ACK_SIGNOFF = `The ${site.name} team`

/**
 * CASL footer: who sent this and where we are. This message answers an inquiry the person sent us, so it is not
 * a promotional email; the footer says so and tells them how to stop further mail. Review with counsel.
 */
export function leadAckFooterLines(): string[] {
  const address = site.addressLines.filter(Boolean).join(', ')
  return [
    `You are receiving this one-time confirmation because you sent a message through the ${site.name} website. It is not an advertisement.`,
    `Sent by ${site.name}${address ? `, ${address}` : ''}${site.phone ? `, ${site.phone}` : ''}.`,
    'If you do not want to hear from us, reply to this email and say so, and we will stop.',
  ]
}
