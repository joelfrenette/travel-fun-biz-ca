import { FollowupsPanel } from "@/components/admin/followups-panel"

export default function FollowUpsPage() {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Daily follow-ups</h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        A short list built fresh each day from the daily brief and the suggestions to bring in more visitors and leads. Up to eight tasks, best first. Tick Done when you finish one, or push it to Later.
      </p>
      <FollowupsPanel />
    </div>
  )
}
