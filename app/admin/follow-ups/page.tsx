import { FollowupsPanel } from "@/components/admin/followups-panel"

// Daily follow-ups: ONLY the list. Each task has "Do this for me" (a draft in a box, nothing sent) or "Copy for Claude".
export default function FollowUpsPage() {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold">Daily follow-ups</h1>
      <FollowupsPanel />
    </div>
  )
}
