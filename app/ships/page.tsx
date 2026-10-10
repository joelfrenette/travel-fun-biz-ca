import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("ships")
}

export default async function ShipsIndexPage() {
  return GuideIndexPage({ kind: "ships" })
}
