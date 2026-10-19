"use client"

import type { ReactNode } from "react"
import { track } from "@/lib/analytics-client"

interface PhoneLinkProps {
  /** A tel: or sms: address. Nothing is drawn when it is empty. */
  href: string | null | undefined
  /** Where on the page the link sits (for example "sticky_bar" or "package_card"). */
  method: string
  className?: string
  children: ReactNode
}

/** The analytics event name for a tel: or sms: address. */
export function phoneEventName(href: string): "phone_click" | "sms_click" {
  return href.trim().toLowerCase().startsWith("sms:") ? "sms_click" : "phone_click"
}

// One tap to call or text. Counts the tap through the existing track() so the admin can see which pages
// make people pick up the phone. Renders nothing when there is no number to dial.
export function PhoneLink({ href, method, className, children }: PhoneLinkProps) {
  const target = (href ?? "").trim()
  if (!target) return null
  return (
    <a
      href={target}
      className={className}
      onClick={() => track(phoneEventName(target), { page_path: window.location.pathname, method })}
    >
      {children}
    </a>
  )
}
