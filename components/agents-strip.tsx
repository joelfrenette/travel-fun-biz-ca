import Link from "next/link"
import { AgentCard } from "@/components/agents-ui"
import { monthLabel, type PublicAgent } from "@/lib/agents"

// "Meet our travel specialists" for the home page: the agent of the month plus up to 3 featured agents. Renders nothing at all
// when there is nobody to show (no migration yet, nobody published and featured), so it can never leave an empty box.
export function AgentsStrip({ aotm, featured }: { aotm: { month: string; blurb: string | null; agent: PublicAgent } | null; featured: PublicAgent[] }) {
  if (!aotm && featured.length === 0) return null
  return (
    <section className="container mx-auto px-4 py-12" aria-labelledby="meet-specialists">
      <h2 id="meet-specialists" className="text-center text-2xl font-bold text-foreground">Meet our travel specialists</h2>
      <p className="mx-auto mt-2 max-w-2xl text-center text-sm text-muted-foreground">Real people who know their destinations. Send an enquiry and our office will match you with the right one.</p>
      <ul className="mx-auto mt-6 grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {aotm && <AgentCard agent={aotm.agent} badge={`Specialist of the month, ${monthLabel(aotm.month)}`} />}
        {featured.map((a) => <AgentCard key={a.id} agent={a} />)}
      </ul>
      <p className="mt-6 text-center"><Link href="/agents" className="text-sm font-medium text-primary hover:underline">See all our travel specialists</Link></p>
    </section>
  )
}
