import { UserRound } from "lucide-react"
import type { AdminNavItem } from "@/lib/admin-nav"

// The Agents back office menu entry, kept in its own file so adding it needs only a one-line change in lib/admin-nav.ts:
//   import { agentsNavItem } from "@/lib/admin-nav-agents"   (top of file)
//   ...and add `agentsNavItem,` to the `unsortedTools` array.
export const agentsNavItem: AdminNavItem = {
  title: "Travel Agents",
  description: "The roster of travel specialists: import from your spreadsheet, send each agent a profile link, approve bios, photos and videos, pick the agent of the month, and publish their /agents pages.",
  icon: UserRound,
  href: "/admin/agents",
  status: "Active",
}
