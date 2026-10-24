import { AgentsPanel } from "@/components/admin/agents-panel"

export const dynamic = "force-dynamic"

export default function AdminAgentsPage() {
  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold">Travel Agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your roster of travel specialists and their public pages at /agents. Leads always go through the website form: an agent&apos;s own phone and email are never shown to visitors.
        </p>
      </div>
      <AgentsPanel />
    </div>
  )
}
