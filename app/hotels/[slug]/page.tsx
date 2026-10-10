import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("hotels", params.slug)
}

export default async function HotelGuidePage({ params }: Props) {
  return GuidePage({ kind: "hotels", slug: params.slug })
}
