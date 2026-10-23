import { RecapShareForm } from "@/components/recap-share-form"

export const dynamic = "force-dynamic"

export default function RecapSharePage({ params }: { params: { token: string } }) {
  return <RecapShareForm token={params.token} />
}
