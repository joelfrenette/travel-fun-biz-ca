import { NextResponse } from "next/server"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"
import { contactFormSchema } from "@/lib/schemas/contact"
import { z } from "zod"

const requestSchema = contactFormSchema.extend({
  submittedAt: z.string().optional(),
})

export async function POST(request: Request) {
  try {
    const json = await request.json()
    const parsed = requestSchema.safeParse(json)

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid form data", issues: parsed.error.flatten() }, { status: 400 })
    }

    const data = {
      ...parsed.data,
      submittedAt: parsed.data.submittedAt || new Date().toISOString(),
    }

    console.log("[lead] Submission received", {
      package: data.package,
      submittedAt: data.submittedAt,
    })

    const success = await submitLeadToGoHighLevel(data)

    if (success) {
      return NextResponse.json({
        success: true,
        message: "Lead submitted successfully",
      })
    }

    return NextResponse.json({ error: "Failed to submit lead to CRM" }, { status: 500 })
  } catch (error) {
    console.error("[lead] Error submitting lead:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}