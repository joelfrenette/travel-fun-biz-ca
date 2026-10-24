"use client"

import { TodayStack } from "@/components/admin/today-stack"

// Today: the system check strip (with the top fixes), the swipe cards, and the daily follow-ups (collapsible).
// The dashboard (traffic, funnel, tools) is its own page at /admin/dashboard.
export default function AdminTodayPage() {
  return (
    <div className="container mx-auto px-4 py-6">
      <TodayStack />
    </div>
  )
}
