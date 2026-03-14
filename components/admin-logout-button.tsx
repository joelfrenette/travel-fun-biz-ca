"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

export function AdminLogoutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function handleLogout() {
    setPending(true)
    try {
      await fetch("/api/admin/logout", { method: "POST" })
      router.replace("/admin/login")
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="outline" onClick={handleLogout} disabled={pending}>
      {pending ? "Signing out..." : "Sign Out"}
    </Button>
  )
}