import { NextResponse } from "next/server"
import { submitLeadToGoHighLevel } from "@/lib/gohighlevel"

export async function POST(request: Request) {
  try {
    const data = await request.json()

    // Validate required fields
    if (!data.name || !data.email || !data.package) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(data.email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 })
    }

    console.log("[v0] Lead submission received:", {
      name: data.name,
      email: data.email,
      package: data.package,
      submittedAt: data.submittedAt,
    })

    const success = await submitLeadToGoHighLevel({
      name: data.name,
      email: data.email,
      phone: data.phone,
      package: data.package,
      travelDate: data.travelDate,
      travelers: data.travelers,
      message: data.message,
      submittedAt: data.submittedAt,
    })

    if (success) {
      console.log("[v0] Lead successfully submitted to GoHighLevel")
      return NextResponse.json({
        success: true,
        message: "Lead submitted successfully",
      })
    } else {
      console.error("[v0] Failed to submit lead to GoHighLevel")
      return NextResponse.json({ error: "Failed to submit lead to CRM" }, { status: 500 })
    }
  } catch (error) {
    console.error("[v0] Error submitting lead:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
