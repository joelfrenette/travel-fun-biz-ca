// GoHighLevel API Integration for Lead Management

interface LeadData {
  name: string
  email: string
  phone?: string
  package: string
  travelDate?: string
  travelers?: string
  message?: string
  submittedAt: string
}

export async function submitLeadToGoHighLevel(leadData: LeadData): Promise<boolean> {
  const apiKey = process.env.GOHIGHLEVEL_API_KEY
  const locationId = process.env.GOHIGHLEVEL_LOCATION_ID

  if (!apiKey || !locationId) {
    console.log("[v0] GoHighLevel integration not configured")
    return false
  }

  try {
    // Create contact in GoHighLevel
    const contactResponse = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locationId: locationId,
        firstName: leadData.name.split(" ")[0],
        lastName: leadData.name.split(" ").slice(1).join(" ") || "",
        email: leadData.email,
        phone: leadData.phone || "",
        tags: ["travel-lead", leadData.package.toLowerCase().replace(/\s+/g, "-")],
        customFields: [
          {
            key: "package_interest",
            value: leadData.package,
          },
          {
            key: "travel_date",
            value: leadData.travelDate || "",
          },
          {
            key: "number_of_travelers",
            value: leadData.travelers || "",
          },
          {
            key: "message",
            value: leadData.message || "",
          },
          {
            key: "lead_source",
            value: "Website Contact Form",
          },
        ],
      }),
    })

    if (!contactResponse.ok) {
      const errorData = await contactResponse.json()
      console.error("[v0] GoHighLevel API error:", errorData)
      return false
    }

    const contactData = await contactResponse.json()
    console.log("[v0] Contact created in GoHighLevel:", contactData.contact?.id)

    // Optional: Create an opportunity for the lead
    if (contactData.contact?.id) {
      await createOpportunity(apiKey, locationId, contactData.contact.id, leadData)
    }

    return true
  } catch (error) {
    console.error("[v0] Error submitting to GoHighLevel:", error)
    return false
  }
}

async function createOpportunity(
  apiKey: string,
  locationId: string,
  contactId: string,
  leadData: LeadData,
): Promise<void> {
  try {
    const pipelineId = process.env.GOHIGHLEVEL_PIPELINE_ID

    if (!pipelineId) {
      console.log("[v0] Pipeline ID not configured, skipping opportunity creation")
      return
    }

    const opportunityResponse = await fetch("https://rest.gohighlevel.com/v1/opportunities/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locationId: locationId,
        pipelineId: pipelineId,
        contactId: contactId,
        name: `${leadData.package} - ${leadData.name}`,
        status: "open",
        source: "Website",
      }),
    })

    if (opportunityResponse.ok) {
      const opportunityData = await opportunityResponse.json()
      console.log("[v0] Opportunity created in GoHighLevel:", opportunityData.opportunity?.id)
    }
  } catch (error) {
    console.error("[v0] Error creating opportunity:", error)
  }
}
