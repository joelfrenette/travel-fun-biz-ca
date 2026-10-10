import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("yachts", params.slug)
}

export default async function YachtGuidePage({ params }: Props) {
  return GuidePage({ kind: "yachts", slug: params.slug })
}
