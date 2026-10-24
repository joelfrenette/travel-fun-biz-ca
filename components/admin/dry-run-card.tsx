"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, FlaskConical, AlertTriangle } from "lucide-react"
import { DRY_RUN_BANNER_BODY, DRY_RUN_BANNER_TITLE, DRY_RUN_EXPLAINER, EFFECT_LABELS, ceilingSentence, type DryPass } from "@/lib/dry-run-shape"

export interface DryRunState {
  on: boolean
  since: string | null
  hours: number | null
  log: DryPass[]
}

const when = (iso: string) => new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })

/** The big banner. Shown at the top of the Autopilot page for as long as the dry run switch is on. */
export function DryRunBanner({ dryRun }: { dryRun: DryRunState }) {
  if (!dryRun.on) return null
  return (
    <div role="alert" className="border-b-4 border-amber-500 bg-amber-100 px-4 py-4 text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <div className="container mx-auto flex items-start gap-3">
        <AlertTriangle className="mt-1 h-8 w-8 shrink-0" />
        <div>
          <p className="text-2xl font-extrabold tracking-wide">{DRY_RUN_BANNER_TITLE}</p>
          <p className="text-sm">{DRY_RUN_BANNER_BODY}</p>
          {dryRun.hours !== null && <p className="mt-1 text-sm font-semibold">It has been on for {dryRun.hours} hour{dryRun.hours === 1 ? "" : "s"}.</p>}
        </div>
      </div>
    </div>
  )
}

/** The switch, a plain explanation and the last 5 rehearsals. */
export function DryRunCard({ dryRun, busy, onToggle }: { dryRun: DryRunState; busy: boolean; onToggle: () => void }) {
  return (
    <Card className={dryRun.on ? "border-amber-500" : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <FlaskConical className={dryRun.on ? "mt-0.5 h-6 w-6 text-amber-600" : "mt-0.5 h-6 w-6 text-muted-foreground"} />
            <div>
              <h2 className="font-semibold">Dry run {dryRun.on ? "is ON" : "is off"}</h2>
              <p className="max-w-2xl text-xs text-muted-foreground">{DRY_RUN_EXPLAINER}</p>
            </div>
          </div>
          <Button size="sm" variant={dryRun.on ? "default" : "outline"} disabled={busy} onClick={onToggle}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {dryRun.on ? "Turn dry run off" : "Turn dry run on"}
          </Button>
        </div>

        {dryRun.log.length === 0 ? (
          <p className="text-sm text-muted-foreground">No dry run has happened yet. With the switch on, the next 15 minute pass (or the run button above) writes its answer here.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Last {dryRun.log.length} dry run{dryRun.log.length === 1 ? "" : "s"}, newest first</p>
            {[...dryRun.log].reverse().map((p) => (
              <div key={p.at} className="space-y-1 rounded-md border p-3 text-sm">
                <p className="text-xs text-muted-foreground">{when(p.at)} ({p.trigger === "button" ? "run button" : "scheduled"}) · {p.aiCalls} AI call{p.aiCalls === 1 ? "" : "s"} would be made</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {p.steps.map((s, i) => <li key={`${s.step}-${i}`} className="text-xs">{s.note}</li>)}
                </ul>
                {p.intents.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">What it would do</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {p.intents.map((it, i) => <li key={`${it.kind}-${i}`} className="text-xs"><span className="font-medium">{EFFECT_LABELS[it.kind]}:</span> {it.detail}</li>)}
                    </ul>
                  </div>
                )}
                <p className={p.ceiling.wouldExceed ? "text-xs font-semibold text-destructive" : "text-xs text-muted-foreground"}>{ceilingSentence(p.ceiling)}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
