import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("ships", params.slug)
}

export default async function ShipGuidePage({ params }: Props) {
  return GuidePage({ kind: "ships", slug: params.slug })
}
