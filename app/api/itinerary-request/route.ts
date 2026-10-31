import { NextResponse } from "next/server"
import { allowRequest } from "@/lib/abuse-guard"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"
import { saveLeadFirst, markLeadSent } from "@/lib/leads"
import { sendLeadAck } from "@/lib/lead-ack"
import { getPublishedPackageBySlug } from "@/lib/packages"
import { SITE_URL } from "@/lib/site"
import { itinerarySecret } from "@/lib/itinerary-magnet"
import { handleItineraryRequest } from "@/lib/itinerary-magnet-run"
import { getItineraryMagnetMode, recordItineraryRequest, writeLeadMessage } from "@/lib/itinerary-magnet-store"
import { getTripQuizMode, recordQuizEvent } from "@/lib/trip-quiz-store"
import type { ContactSubmission } from "@/lib/schemas/contact"

// Public: "Send me the itinerary and dates" on a trip page. All of the logic is in lib/itinerary-magnet-run.ts (checked offline
// by scripts/check-itinerary-magnet.ts). Off by default: with app_settings itinerary_magnet_mode not "on" this answers 404.
export async function POST(request: Request) {
  try {
    const json = await request.json().catch(() => null)
    const out = await handleItineraryRequest(json, {
      getMode: () => getItineraryMagnetMode(),
      allow: () => allowRequest(request, "itinerary-request", 5, 600),
      getTrip: async (slug) => {
        const p = await getPublishedPackageBySlug(slug)
        return p ? { name: p.name, slug: p.slug, available_to: p.available_to, recap_mode: p.recap_mode } : null
      },
      saveLead: (lead) => saveLeadFirst(lead),
      forward: (lead) => submitLeadToGoHighLevel(lead as unknown as ContactSubmission),
      markSent: (id, result) => markLeadSent(id, result),
      sendAck: (input) => sendLeadAck(input),
      noteEmail: (id, message) => writeLeadMessage(id, message),
      bumpCount: (slug) => recordItineraryRequest(slug),
      // The trip quiz (lib/trip-quiz.ts) sends its lead through this same route with a `quiz` field and follows its own switch.
      getQuizMode: () => getTripQuizMode(),
      bumpQuiz: () => recordQuizEvent("email"),
      secret: itinerarySecret,
      now: () => new Date(),
      origin: SITE_URL,
    })
    return NextResponse.json(out.body, { status: out.status })
  } catch (error) {
    console.error("[itinerary-request] failed", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
