// Browser safe, no imports: the check the itinerary form runs before it sends anything. Same rules as itineraryRequestSchema
// (lib/itinerary-magnet.ts), which the server enforces again.

/** The message to show, or null when the form may be sent. An unticked consent box always blocks the send. */
export function itineraryFormProblem(v: { name: string; email: string; consent: boolean }): string | null {
  if (!v.name.trim()) return 'Please tell us your name'
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) return 'Enter a valid email'
  if (!v.consent) return 'Please tick the box so we are allowed to email you'
  return null
}
