import { missingFacts, type MissingFact } from '@/lib/trip-checklist'

// The two ways the add-a-trip wizard (components/package-wizard.tsx) talks to the server (WP13). The wizard itself does
// not know which one it has: the admin button hands it adminApi() (Bearer token, /api/admin routes), the public agent
// page hands it agentApi(token) (the link's token in the path, /api/submit-trip routes). Both end in the same shared
// server functions (lib/package-ingest.ts, lib/trip-wizard.ts). Client-safe: only fetch and pure helpers.

export type SourceKindLabel = 'screenshot' | 'pdf' | 'url' | 'text'

/** One thing in the drop queue. Screenshots dropped together are ONE item (one source, one model call). */
export type DropItem =
  | { id: string; kind: 'images'; files: File[]; label: string }
  | { id: string; kind: 'pdf'; files: File[]; label: string }
  | { id: string; kind: 'url'; url: string; label: string }
  | { id: string; kind: 'text'; text: string; label: string }

export interface WizardField {
  key: string
  label: string
  value: string
  filled: boolean
  /** The value is not shown to this person (a price on the agent page shows only "found"). */
  hidden?: boolean
  editable: boolean
  multiline?: boolean
  /** Has an "Improve with AI" button. */
  improvable?: boolean
}

export interface WizardSource {
  id: string
  kind: string
  label: string
  status: string
  filled: string[]
  failed: boolean
}

export interface WizardView {
  id: string
  name: string
  /** False once the draft is locked for this person (sent to Joel, or published). */
  editable: boolean
  /** Agent only. */
  stateLabel?: string
  reviewNote?: string | null
  state?: string
  fields: WizardField[]
  sources: WizardSource[]
  missing: MissingFact[]
  score: number | null
  coverUrl: string | null
  hasCover: boolean
  coverIllustrative: boolean
  galleryCount: number
  canSend?: boolean
}

export interface WizardApi {
  mode: 'admin' | 'agent'
  start(name: string): Promise<string>
  view(id: string): Promise<WizardView>
  addSource(id: string, item: DropItem): Promise<string>
  readSource(id: string, sourceId: string): Promise<{ filled: string[]; error?: string }>
  complete(id: string): Promise<{ filled: string[]; error?: string; notes?: string[] }>
  save(id: string, patch: Record<string, string>): Promise<void>
  improve(id: string, field: string): Promise<{ applied: boolean; error?: string }>
  addPhotos(id: string, files: File[]): Promise<{ added: number; skipped: string[]; error?: string }>
  /** admin: 'publish' | 'draft'; agent: 'send'. */
  finish(id: string, action: 'publish' | 'draft' | 'send'): Promise<{ error?: string; missing?: string[] }>
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
}

function formFor(item: DropItem): { body?: FormData; json?: Record<string, string> } {
  if (item.kind === 'images' || item.kind === 'pdf') {
    const form = new FormData()
    item.files.forEach((f) => form.append('file', f))
    return { body: form }
  }
  return { json: item.kind === 'url' ? { url: item.url } : { text: item.text } }
}

/** The labels of the text fields each surface lets a person edit. */
const ADMIN_EDITABLE = ['name', 'destination', 'short_description', 'full_description', 'highlights', 'price_includes', 'not_included', 'duration', 'price_display'] as const
const MULTILINE = new Set(['short_description', 'full_description', 'highlights', 'price_includes', 'not_included'])
const IMPROVABLE = new Set(['short_description', 'full_description', 'highlights'])
const ADMIN_LABELS: Record<string, string> = {
  name: 'Trip name', destination: 'Destination', short_description: 'Short description', full_description: 'Trip description', highlights: 'Highlights (one per line)',
  price_includes: 'What is included (one per line)', not_included: 'What is not included (one per line)', duration: 'How long the trip is', price_display: 'Price as shown',
}

function asText(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : '')).filter(Boolean).join('\n')
  return String(v)
}

// ─── Admin ───────────────────────────────────────────────────────────────────────

export function adminApi(): WizardApi {
  const auth = (json = true): HeadersInit => {
    const h: Record<string, string> = { Authorization: `Bearer ${localStorage.getItem('adminToken') || ''}` }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }
  const act = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/packages/${id}/wizard`, { method: 'POST', headers: auth(), body: JSON.stringify(body) })
    return { res, data: await readJson(res) }
  }
  return {
    mode: 'admin',
    async start(name) {
      const res = await fetch('/api/admin/packages', { method: 'POST', headers: auth(), body: JSON.stringify({ stub: true, name: name || undefined, status: 'draft' }) })
      const data = await readJson(res)
      const pkg = data.package as { id?: string } | undefined
      if (!res.ok || !pkg?.id) throw new Error(String(data.error ?? `Could not start the trip (HTTP ${res.status})`))
      return pkg.id
    },
    async view(id) {
      const [pr, sr] = await Promise.all([fetch(`/api/admin/packages/${id}`, { headers: auth(false) }), fetch(`/api/admin/packages/${id}/sources`, { headers: auth(false) })])
      const pd = await readJson(pr)
      const sd = await readJson(sr)
      const row = pd.package as Record<string, unknown> | undefined
      if (!pr.ok || !row) throw new Error(String(pd.error ?? 'Could not load the trip'))
      const sources = ((sd.sources as { id: string; kind: string; file_name: string | null; source_url: string | null; status: string; applied_fields: string[] }[] | undefined) ?? []).filter((s) => !/^(Automatic FAQs|Photos added)/i.test(s.file_name ?? ''))
      const gallery = Array.isArray(row.gallery_urls) ? (row.gallery_urls as unknown[]).length : 0
      return {
        id,
        name: String(row.name ?? ''),
        editable: true,
        fields: ADMIN_EDITABLE.map((key) => ({ key, label: ADMIN_LABELS[key], value: asText(row[key]), filled: asText(row[key]).trim().length > 0, editable: true, multiline: MULTILINE.has(key), improvable: IMPROVABLE.has(key) })),
        sources: sources.map((s) => ({ id: s.id, kind: s.kind, label: s.kind === 'url' ? (s.source_url ?? 'Link') : s.kind === 'text' ? 'Pasted text' : (s.file_name ?? s.kind), status: s.status, filled: s.applied_fields ?? [], failed: s.status === 'failed' })),
        missing: missingFacts(row),
        score: (sd.completeness as { score?: number } | undefined)?.score ?? null,
        coverUrl: typeof row.image_url === 'string' && row.image_url ? row.image_url : null,
        hasCover: typeof row.image_url === 'string' && !!row.image_url,
        coverIllustrative: row.image_source === 'pexels',
        galleryCount: gallery,
      }
    },
    async addSource(id, item) {
      const f = formFor(item)
      const res = await fetch(`/api/admin/packages/${id}/sources`, { method: 'POST', headers: auth(!f.body), body: f.body ?? JSON.stringify(f.json) })
      const data = await readJson(res)
      const src = data.source as { id?: string } | undefined
      if (!res.ok || !src?.id) throw new Error(String(data.error ?? `Could not add that (HTTP ${res.status})`))
      return src.id
    },
    async readSource(id, sourceId) {
      const res = await fetch(`/api/admin/packages/${id}/sources/${sourceId}/extract`, { method: 'POST', headers: auth() })
      const data = await readJson(res)
      if (!res.ok) return { filled: [], error: String(data.error ?? `Could not read it (HTTP ${res.status})`) }
      return { filled: (data.applied as string[] | undefined) ?? [] }
    },
    async complete(id) {
      const { res, data } = await act(id, { action: 'complete' })
      if (!res.ok && !data.applied) return { filled: [], error: String(data.error ?? 'Could not complete the trip') }
      return { filled: (data.applied as string[] | undefined) ?? [], notes: data.notes as string[] | undefined, error: data.error ? String(data.error) : undefined }
    },
    async save(id, patch) {
      const body: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'highlights') body[k] = v.split('\n').map((x) => x.trim()).filter(Boolean)
        else body[k] = v
      }
      const res = await fetch(`/api/admin/packages/${id}`, { method: 'PUT', headers: auth(), body: JSON.stringify(body) })
      if (!res.ok) throw new Error(String((await readJson(res)).error ?? `Could not save (HTTP ${res.status})`))
    },
    async improve(id, field) {
      const { res, data } = await act(id, { action: 'improve', field })
      return { applied: !!data.applied, error: res.ok && data.error ? String(data.error) : !res.ok ? String(data.error ?? 'Could not rewrite it') : undefined }
    },
    async addPhotos(id, files) {
      const form = new FormData()
      files.forEach((f) => form.append('file', f))
      const res = await fetch(`/api/admin/packages/${id}/wizard/photos`, { method: 'POST', headers: auth(false), body: form })
      const data = await readJson(res)
      return { added: Number(data.added ?? 0), skipped: ((data.skipped as { name: string; reason: string }[] | undefined) ?? []).map((s) => `${s.name}: ${s.reason}`), error: res.ok ? undefined : String(data.error ?? 'Could not add the photos') }
    },
    async finish(id, action) {
      if (action !== 'publish') return {}
      const { res, data } = await act(id, { action: 'publish' })
      return res.ok ? {} : { error: String(data.error ?? 'Could not publish'), missing: data.missing as string[] | undefined }
    },
  }
}

// ─── Agent ───────────────────────────────────────────────────────────────────────

export function agentApi(token: string): WizardApi {
  const base = `/api/submit-trip/${token}`
  const json = { 'Content-Type': 'application/json' }
  const post = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    const res = await fetch(`${base}${path}`, { method, headers: json, body: JSON.stringify(body) })
    return { res, data: await readJson(res) }
  }
  const toView = (id: string, d: Record<string, unknown>): WizardView => {
    const draft = d as {
      tripName: string; editable: boolean; stateLabel: string; reviewNote: string | null; state: string; score: number; canSend: boolean
      fields: { key: string; label: string; filled: boolean; value: string | null; hidden?: boolean }[]
      sources: WizardSource[]; missing: MissingFact[]; datesNote?: string
    }
    const editableKeys = new Set(['name', 'destination', 'short_description', 'highlights', 'price_includes'])
    const fields: WizardField[] = draft.fields.map((f) => ({
      key: f.key, label: f.key === 'highlights' ? 'Highlights (one per line)' : f.key === 'price_includes' ? 'What is included (one per line)' : f.label,
      value: f.value ?? '', filled: f.filled, hidden: f.hidden, editable: draft.editable && editableKeys.has(f.key), multiline: MULTILINE.has(f.key), improvable: IMPROVABLE.has(f.key) && draft.editable,
    }))
    const cover = draft.fields.find((f) => f.key === 'image_url')
    const gallery = draft.fields.find((f) => f.key === 'gallery_urls')
    return {
      id, name: draft.tripName, editable: draft.editable, stateLabel: draft.stateLabel, reviewNote: draft.reviewNote, state: draft.state,
      fields: [...fields.filter((f) => f.key !== 'image_url' && f.key !== 'gallery_urls'), { key: 'dates_note', label: 'Dates, if you know them', value: draft.datesNote ?? '', filled: !!draft.datesNote, editable: draft.editable }],
      sources: draft.sources, missing: draft.missing, score: draft.score, coverUrl: null, hasCover: !!cover?.filled, coverIllustrative: false, galleryCount: gallery?.filled ? 1 : 0, canSend: draft.canSend,
    }
  }
  return {
    mode: 'agent',
    async start(name) {
      const { res, data } = await post('', { action: 'start', tripName: name })
      if (!res.ok || typeof data.draftId !== 'string') throw new Error(String(data.error ?? 'Could not start the trip'))
      return data.draftId
    },
    async view(id) {
      const res = await fetch(`${base}/drafts/${id}`)
      const data = await readJson(res)
      if (!res.ok || !data.draft) throw new Error(String(data.error ?? 'Could not load the trip'))
      return toView(id, data.draft as Record<string, unknown>)
    },
    async addSource(id, item) {
      const f = formFor(item)
      const res = await fetch(`${base}/drafts/${id}/sources`, { method: 'POST', headers: f.body ? undefined : json, body: f.body ?? JSON.stringify(f.json) })
      const data = await readJson(res)
      if (!res.ok || typeof data.sourceId !== 'string') throw new Error(String(data.error ?? 'Could not add that'))
      return data.sourceId
    },
    async readSource(id, sourceId) {
      const { res, data } = await post(`/drafts/${id}/sources/${sourceId}`, {})
      return res.ok ? { filled: (data.filled as string[] | undefined) ?? [] } : { filled: [], error: String(data.error ?? 'We could not read that one') }
    },
    async complete(id) {
      const { res, data } = await post(`/drafts/${id}`, { action: 'complete' })
      return { filled: (data.filled as string[] | undefined) ?? [], error: res.ok ? undefined : String(data.error ?? 'Could not complete the trip') }
    },
    async save(id, patch) {
      const { res, data } = await post(`/drafts/${id}`, patch, 'PATCH')
      if (!res.ok) throw new Error(String(data.error ?? 'Could not save'))
    },
    async improve(id, field) {
      const { res, data } = await post(`/drafts/${id}`, { action: 'improve', field })
      return { applied: !!data.applied, error: res.ok && !data.error ? undefined : String(data.error ?? 'Could not rewrite it') }
    },
    async addPhotos(id, files) {
      const form = new FormData()
      files.forEach((f) => form.append('file', f))
      const res = await fetch(`${base}/drafts/${id}/photos`, { method: 'POST', body: form })
      const data = await readJson(res)
      return { added: Number(data.added ?? 0), skipped: (data.skipped as string[] | undefined) ?? [], error: res.ok ? undefined : String(data.error ?? 'Could not add the photos') }
    },
    async finish(id, action) {
      if (action !== 'send') return {}
      const { res, data } = await post(`/drafts/${id}`, { action: 'send' })
      return res.ok ? {} : { error: String(data.error ?? 'Could not send') }
    },
  }
}
