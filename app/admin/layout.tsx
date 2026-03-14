import type { ReactNode } from "react"
import Link from "next/link"
import { AdminLogoutButton } from "@/components/admin-logout-button"

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="space-y-1">
            <p className="text-sm uppercase text-muted-foreground">TravelFunBiz Admin</p>
            <h1 className="text-xl font-semibold">Control Center</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-primary hover:underline">
              View site
            </Link>
            <AdminLogoutButton />
          </div>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8">{children}</main>
    </div>
  )
}
