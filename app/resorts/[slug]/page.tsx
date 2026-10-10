import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("resorts", params.slug)
}

export default async function ResortGuidePage({ params }: Props) {
  return GuidePage({ kind: "resorts", slug: params.slug })
}
