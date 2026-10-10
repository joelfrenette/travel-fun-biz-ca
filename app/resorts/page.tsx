import { GuideIndexPage, guideIndexMetadata } from "@/components/guide-index-page"

export const revalidate = 300

export async function generateMetadata() {
  return guideIndexMetadata("resorts")
}

export default async function ResortsIndexPage() {
  return GuideIndexPage({ kind: "resorts" })
}
