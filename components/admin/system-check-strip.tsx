"use client"

import Link from "next/link"
import type { SystemCheck } from "@/lib/today-queue"
import type { CheckSummary } from "@/lib/system-check"
import { cn } from "@/lib/utils"

// The slim strip at the very top of Today: is the machine healthy? It shows the overall light and the worst stage of the full
// system check, and links to the page with every stage. The colour always comes with words, so it reads the same for someone who
// cannot tell the colours apart. If the full check could not be read, the older short list of five checks is shown instead.

const DOT: Record<string, string> = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }
const WORD: Record<string, string> = { green: "OK", amber: "Check", red: "Problem" }
const HEAD: Record<string, string> = { green: "all good", amber: "worth a look", red: "needs you" }
const FRAME: Record<string, string> = {
  green: "border-emerald-500/40 bg-emerald-500/5",
  amber: "border-amber-500/50 bg-amber-500/5",
  red: "border-red-500/50 bg-red-500/5",
}

export function SystemCheckStrip({ system, check }: { system: SystemCheck | null; check?: CheckSummary | null }) {
  if (!system) {
    return <div className="mb-4 h-14 animate-pulse rounded-lg border bg-muted/40" aria-hidden="true" />
  }
  if (check) {
    return (
      <section aria-label="System check" className={cn("mb-4 rounded-lg border px-3 py-2", FRAME[check.overall])}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className={cn("h-2.5 w-2.5 rounded-full", DOT[check.overall])} aria-hidden="true" />
            System check: <span className="font-normal">{HEAD[check.overall]}</span>
          </h2>
          <Link href="/admin/system-check" className="inline-flex min-h-8 items-center text-xs font-medium text-primary underline underline-offset-2">
            Open the system check
          </Link>
        </div>
        {check.worst ? (
          <p className="mt-1 text-xs">
            <span className="font-medium">{check.worst.label}</span>
            <span className="sr-only"> ({WORD[check.worst.light]})</span>
            <span className="break-words text-muted-foreground">: {check.worst.sentence}</span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Every part checked is fine.</p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {check.counts.green} green, {check.counts.amber} amber, {check.counts.red} red
        </p>
      </section>
    )
  }
  return (
    <section aria-label="System check" className={cn("mb-4 rounded-lg border px-3 py-2", FRAME[system.overall])}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          System check: <span className="font-normal">{HEAD[system.overall]}</span>
        </h2>
        <Link href="/admin/system-check" className="text-xs font-medium text-primary underline underline-offset-2">
          Open the system check
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
