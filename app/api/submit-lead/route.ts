import { NextResponse } from "next/server"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"
import { contactSubmissionSchema } from "@/lib/schemas/contact"

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = contactSubmissionSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid form data", issues: parsed.error.flatten() }, { status: 400 })
    }

    const data = { ...parsed.data, submittedAt: parsed.data.submittedAt || new Date().toISOString() }
    console.log("[lead] Submission received", { package: data.package, source: data.attribution?.utm_source, page: data.attribution?.page_path })

    const result = await submitLeadToGoHighLevel(data)
    if (result.ok) return NextResponse.json({ success: true, message: "Lead submitted successfully" })

    return NextResponse.json({ error: result.error }, { status: result.error.includes('not configured') ? 503 : 502 })
  } catch (error) {
    console.error("[lead] Error submitting lead:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
