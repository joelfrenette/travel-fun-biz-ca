import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("hotels")
}

export default async function HotelsIndexPage() {
  return GuideIndexPage({ kind: "hotels" })
}
