import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("cruise-lines", params.slug)
}

export default async function CruiseLineGuidePage({ params }: Props) {
  return GuidePage({ kind: "cruise-lines", slug: params.slug })
}
