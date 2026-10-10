import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("destinations")
}

export default async function DestinationsIndexPage() {
  return GuideIndexPage({ kind: "destinations" })
}
