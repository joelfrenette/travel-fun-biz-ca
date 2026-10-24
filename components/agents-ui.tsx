import Link from "next/link"
import { agentPath, agentPhotoAlt, firstName, type PublicAgent } from "@/lib/agents"

// Shared pieces of the public agent pages. Server components, no client JS. A card never shows a phone or an email:
// the only way to reach an agent is the website form.

export function AgentAvatar({ agent, size = 96 }: { agent: PublicAgent; size?: number }) {
  if (agent.photo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={agent.photo_url} alt={agentPhotoAlt(agent.display_name)} width={size} height={size} loading="lazy" decoding="async" className="rounded-full object-cover" style={{ width: size, height: size }} />
  }
  const initials = agent.display_name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("")
  return (
    <div aria-hidden="true" className="flex items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground" style={{ width: size, height: size }}>
      {initials}
    </div>
  )
}

export function AgentCard({ agent, badge }: { agent: PublicAgent; badge?: string }) {
  return (
    <li className="flex flex-col items-center rounded-xl border bg-card p-5 text-center">
      <AgentAvatar agent={agent} />
      {badge && <p className="mt-3 rounded-full bg-primary/10 px-3 py-0.5 text-xs font-semibold uppercase text-primary">{badge}</p>}
      <h3 className="mt-3 text-lg font-bold text-foreground">
        <Link href={agentPath(agent.slug)} className="hover:underline">{agent.display_name}</Link>
      </h3>
      {agent.headline && <p className="mt-1 text-sm text-muted-foreground">{agent.headline}</p>}
      {agent.specialties.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{agent.specialties.slice(0, 3).join(" | ")}</p>}
      <Link href={agentPath(agent.slug)} className="mt-3 text-sm font-medium text-primary hover:underline" aria-label={`Meet ${agent.display_name}`}>
        Meet {firstName(agent.display_name)}
      </Link>
    </li>
  )
}
