import { GuidePage, guideMetadata } from "@/components/guide-page"

export const revalidate = 300

type Props = { params: { slug: string } }

export async function generateMetadata({ params }: Props) {
  return guideMetadata("river-cruises", params.slug)
}

export default async function RiverCruiseGuidePage({ params }: Props) {
  return GuidePage({ kind: "river-cruises", slug: params.slug })
}
