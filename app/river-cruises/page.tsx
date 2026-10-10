import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("river-cruises")
}

export default async function RiverCruisesIndexPage() {
  return GuideIndexPage({ kind: "river-cruises" })
}
