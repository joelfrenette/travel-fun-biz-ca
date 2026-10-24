"use client"

import { TodayStack } from "@/components/admin/today-stack"

// Today: ONLY the swipe cards. The system check is /admin/system-check, the daily list is /admin/follow-ups,
// and the dashboard (traffic, funnel) is /admin/dashboard.
export default function AdminTodayPage() {
  return (
    <div className="container mx-auto px-4 py-6">
      <TodayStack />
    </div>
  )
}
