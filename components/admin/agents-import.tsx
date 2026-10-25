"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { agentsCall } from "@/components/admin/agents-api"
import { IMPORT_FIELDS, type PreviewRow } from "@/lib/agents-import"

interface Sheet { headers: string[]; rows: string[][]; guess: string[]; skippedPrivate?: string[] }

export function AgentsImport({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("")
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [mapping, setMapping] = useState<string[]>([])
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [err, setErr] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setErr(""); setMsg("")
    try { return await fn() } catch (e) { setErr(e instanceof Error ? e.message : "Failed") } finally { setBusy(false) }
  }

  async function readSheet() {
    const r = await run(() => agentsCall<Sheet>({ action: "parse", text }))
    if (r) { setSheet(r); setMapping(r.guess); setPreview(null) }
  }
  async function doPreview() {
    const r = await run(() => agentsCall<{ rows: PreviewRow[] }>({ action: "preview", text, mapping }))
    if (r) setPreview(r.rows)
  }
  async function doImport() {
    const r = await run(() => agentsCall<{ created: number; skipped: number; errors: string[] }>({ action: "import", text, mapping }))
    if (r) {
      setMsg(`Imported ${r.created} agent${r.created === 1 ? "" : "s"} as drafts (skipped ${r.skipped}).${r.errors.length ? ` Problems: ${r.errors.join(" ")}` : ""}`)
      if (r.created > 0) onDone()
    }
  }
  function onFile(f: File) {
    f.text().then((t) => { setText(t); setSheet(null); setPreview(null) })
  }

  const importable = preview?.filter((p) => p.ok && p.action === "new").length ?? 0
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        In Excel, select your agent rows including the header row, copy, and paste here. Or choose a CSV file. You will map each column and see a preview before anything is saved.
        Nothing is invented: a missing cell stays empty and is listed. Everyone imports as a Draft with photo and bio consent OFF, so nobody becomes public by import.
      </p>
      <Textarea rows={8} aria-label="Pasted spreadsheet cells" placeholder="Paste cells here" value={text} onChange={(e) => { setText(e.target.value); setSheet(null); setPreview(null) }} />
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" aria-label="Choose a CSV file" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
        <Button disabled={busy || !text.trim()} onClick={readSheet}>Read columns</Button>
      </div>
      {err && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{err}</p>}
      {msg && <p role="status" className="rounded-md border bg-muted/40 p-2 text-sm">{msg}</p>}

      {sheet && (
        <div className="space-y-2">
          <h3 className="font-medium">Match your columns ({sheet.rows.length} agent row{sheet.rows.length === 1 ? "" : "s"} found)</h3>
          {!!sheet.skippedPrivate?.length && (
            <p role="status" className="rounded-md border bg-muted/40 p-2 text-sm">
              Left out on purpose (money, tax, ID or birth data, never imported): {sheet.skippedPrivate.map((h) => h.replace(/\s+/g, " ")).join(" | ")}
            </p>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {sheet.headers.map((h, i) => (
              <label key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{h || `(column ${i + 1}, no title)`}</span>
                <select className="h-9 rounded-md border bg-background px-2" value={mapping[i] ?? ""} onChange={(e) => { setMapping(mapping.map((m, j) => (j === i ? e.target.value : m))); setPreview(null) }}>
                  <option value="">Skip this column</option>
                  {IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </label>
            ))}
          </div>
          <Button disabled={busy} variant="outline" onClick={doPreview}>Show preview</Button>
        </div>
      )}

      {preview && (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50"><tr><th className="p-2">Row</th><th className="p-2">Name</th><th className="p-2">Result</th><th className="p-2">Left empty (not invented)</th><th className="p-2">Notes</th></tr></thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.index} className="border-t align-top">
                    <td className="p-2">{p.index + 2}</td>
                    <td className="p-2">{p.value?.display_name ?? "(no name)"}</td>
                    <td className="p-2">{!p.ok ? "Cannot import" : p.action === "new" ? "Will import as draft" : "Skipped"}</td>
                    <td className="p-2">{p.missing.join(", ") || "-"}</td>
                    <td className="p-2">{p.warnings.join(" ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button disabled={busy || importable === 0} onClick={doImport}>Import {importable} agent{importable === 1 ? "" : "s"}</Button>
        </div>
      )}
    </div>
  )
}
