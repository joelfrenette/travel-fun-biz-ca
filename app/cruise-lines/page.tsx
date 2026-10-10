import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("cruise-lines")
}

export default async function CruiseLinesIndexPage() {
  return GuideIndexPage({ kind: "cruise-lines" })
}
