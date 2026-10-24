import { AgentProfileForm } from "@/components/agent-profile-form"

export const dynamic = "force-dynamic"

export default function AgentProfilePage({ params }: { params: { token: string } }) {
  return <AgentProfileForm token={params.token} />
}
