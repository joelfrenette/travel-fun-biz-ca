import { NextResponse } from "next/server"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"
import { contactSubmissionSchema } from "@/lib/schemas/contact"
import { isHoneypotFilled, allowRequest } from "@/lib/abuse-guard"
import { recordLead, saveLeadFirst, markLeadSent } from "@/lib/leads"

export async function POST(request: Request) {
  try {
    const json = await request.json()

    // A filled honeypot means a bot, not a person - a quiet "ok" and nothing else happens, same
    // as this project's own abuse-guard.ts doc comment describes. Real visitors never see this
    // field, so this never affects a genuine submission.
    if (isHoneypotFilled(json)) return NextResponse.json({ success: true })

    const parsed = contactSubmissionSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid form data", issues: parsed.error.flatten() }, { status: 400 })
    }

    // A light per-IP throttle. Fails open (lib/abuse-guard.ts) - a spam guard must never be the
    // thing that takes the lead form down.
    if (!(await allowRequest(request, "submit-lead", 5, 600))) {
      return NextResponse.json({ error: "Too many submissions - please try again shortly" }, { status: 429 })
    }

    const data = { ...parsed.data, submittedAt: parsed.data.submittedAt || new Date().toISOString() }
    console.log("[lead] Submission received", { package: data.package, source: data.attribution?.utm_source, page: data.attribution?.page_path })

    // Saved here BEFORE GoHighLevel is called, so a slow or hanging GHL cannot lose the lead.
    const leadId = await saveLeadFirst(data)
    const result = await submitLeadToGoHighLevel(data)
    if (leadId) await markLeadSent(leadId, result)
    else await recordLead(data, result) // the early save failed: record it now, as before
    if (result.ok) return NextResponse.json({ success: true, message: "Lead submitted successfully" })

    return NextResponse.json({ error: result.error }, { status: result.error.includes('not configured') ? 503 : 502 })
  } catch (error) {
    console.error("[lead] Error submitting lead:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
