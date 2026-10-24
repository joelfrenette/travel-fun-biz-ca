import { NextResponse } from "next/server"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"
import { contactSubmissionSchema } from "@/lib/schemas/contact"
import { isHoneypotFilled, allowRequest } from "@/lib/abuse-guard"
import { submitPackage } from "@/lib/form-errors"
import { resolveLeadResponse } from "@/lib/lead-response"
import { recordLead, saveLeadFirst, markLeadSent } from "@/lib/leads"
import { sendLeadAck } from "@/lib/lead-ack"
import { isTestPerson } from "@/lib/test-data"

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

    const data = { ...parsed.data, package: submitPackage(parsed.data.package), submittedAt: parsed.data.submittedAt || new Date().toISOString() }
    // agent_interest is a HINT from an /agents/<slug> page: the office assigns leads. It only becomes a line in the note.
    if (parsed.data.agent_interest) {
      data.message = `${data.message ? `${data.message}\n` : ""}[Asked about travel specialist: ${parsed.data.agent_interest} (hint only, the office assigns the lead)]`
    }
    console.log("[lead] Submission received", { package: data.package, source: data.attribution?.utm_source, page: data.attribution?.page_path })

    // Saved here BEFORE GoHighLevel is called, so a slow or hanging GHL cannot lose the lead.
    const leadId = await saveLeadFirst(data)
    const result = await submitLeadToGoHighLevel(data)
    if (leadId) await markLeadSent(leadId, result)
    else await recordLead(data, result) // the early save failed: record it now, as before
    // Instant lead reply (OFF by default, see lib/lead-ack.ts). Only for a saved, non-test lead; it never throws
    // and its result is ignored, so it cannot change what the visitor sees.
    // Fire-and-forget like announceLead in lib/leads.ts, so even the setting read never delays the visitor.
    if (leadId) void sendLeadAck({ email: data.email, name: data.name, isTest: isTestPerson(data) }).catch(() => undefined)
    // Saved means the visitor sees success even if GoHighLevel failed: the row stays unforwarded and
    // lib/heal.ts retries it, and Needs attention shows it.
    const outcome = resolveLeadResponse({ saved: !!leadId, ghlOk: result.ok, ghlError: result.ok ? undefined : result.error })
    if (outcome.success) {
      if (outcome.retryLater) console.error("[lead] saved, GoHighLevel send failed (will be retried):", result.ok ? "" : result.error)
      return NextResponse.json({ success: true, message: "Lead submitted successfully" }, { status: outcome.status })
    }

    return NextResponse.json({ error: result.ok ? "Internal server error" : result.error }, { status: outcome.status })
  } catch (error) {
    console.error("[lead] Error submitting lead:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
