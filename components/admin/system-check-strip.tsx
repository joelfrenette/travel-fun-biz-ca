"use client"

import Link from "next/link"
import type { SystemCheck } from "@/lib/today-queue"
import { cn } from "@/lib/utils"

// The slim strip at the very top of Today: is the machine healthy? Green, amber or red per item, in words as well as
// colour (so it reads the same for someone who cannot tell the colours apart).

const DOT: Record<string, string> = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }
const WORD: Record<string, string> = { green: "OK", amber: "Check", red: "Problem" }
const FRAME: Record<string, string> = {
  green: "border-emerald-500/40 bg-emerald-500/5",
  amber: "border-amber-500/50 bg-amber-500/5",
  red: "border-red-500/50 bg-red-500/5",
}

export function SystemCheckStrip({ system }: { system: SystemCheck | null }) {
  if (!system) {
    return <div className="mb-4 h-14 animate-pulse rounded-lg border bg-muted/40" aria-hidden="true" />
  }
  return (
    <section aria-label="System check" className={cn("mb-4 rounded-lg border px-3 py-2", FRAME[system.overall])}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          System check: <span className="font-normal">{system.overall === "green" ? "all good" : system.overall === "amber" ? "worth a look" : "needs you"}</span>
        </h2>
        <Link href={system.link.href} className="text-xs font-medium text-primary underline underline-offset-2">
          {system.link.label}
        </Link>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {system.items.map((item) => (
          <li key={item.key} className="flex min-w-0 items-start gap-1.5">
            <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", DOT[item.light])} aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-medium">{item.label}</span>
              <span className="sr-only"> ({WORD[item.light]})</span>
              <span className="break-words text-muted-foreground">: {item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
