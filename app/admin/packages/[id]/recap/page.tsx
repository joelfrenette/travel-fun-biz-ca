"use client"

import { RecapStudio } from "@/components/admin/recap-studio"

export default function RecapStudioPage({ params }: { params: { id: string } }) {
  return <RecapStudio packageId={params.id} />
}
