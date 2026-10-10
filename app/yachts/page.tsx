import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("yachts")
}

export default async function YachtsIndexPage() {
  return GuideIndexPage({ kind: "yachts" })
}
