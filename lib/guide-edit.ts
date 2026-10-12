import { parseScope, type GuideScope } from '@/lib/guide-scope'
import { generateSlug } from '@/lib/utils'

// Hand edits made on one guide from the admin (growth loop WP16). The text fields are the ones the daily heal also
// writes, so an edit made here can be logged in the same audit table and put back with the existing Undo (the
// Content edits screen). The checks live here as plain code so the server route and the offline check agree.

export const EDITABLE_TEXT_FIELDS = ['meta_title', 'meta_description', 'og_title', 'og_description'] as const
export type EditableTextField = (typeof EDITABLE_TEXT_FIELDS)[number]

const LIMITS: Record<EditableTextField, number> = { meta_title: 70, meta_description: 200, og_title: 70, og_description: 140 }
const DASH = /[–—]|\s--\s/

export interface GuideEditPatch {
  text: Partial<Record<EditableTextField, string>>
  scope?: GuideScope | null
  parent_slug?: string | null
  review_state?: 'rejected' | null
}

/** Checks a request body for the edit route. Only the named fields are read, anything else is ignored. Pure. */
export function validateGuideEdit(body: unknown): { ok: true; patch: GuideEditPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Nothing to change.' }
  const b = body as Record<string, unknown>
  const patch: GuideEditPatch = { text: {} }
  for (const field of EDITABLE_TEXT_FIELDS) {
    if (!(field in b)) continue
    const v = b[field]
    if (typeof v !== 'string') return { ok: false, error: `${field} must be text.` }
    const text = v.replace(/\s+/g, ' ').trim()
    if (text.length === 0) return { ok: false, error: `${field} cannot be empty.` }
    if (text.length > LIMITS[field]) return { ok: false, error: `${field} is too long (${text.length} characters, the limit is ${LIMITS[field]}).` }
    if (DASH.test(text)) return { ok: false, error: `${field} has a dash. Use a comma or a full stop instead.` }
    if (/https?:\/\//i.test(text)) return { ok: false, error: `${field} cannot hold a web address.` }
    patch.text[field] = text
  }
  if ('scope' in b) {
    if (b.scope === null || b.scope === '') patch.scope = null
    else {
      const s = parseScope(b.scope)
      if (!s) return { ok: false, error: 'That is not a scope. Pick country, region, city, port, supplier, property, line, ship or class.' }
      patch.scope = s
    }
  }
  if ('parent_slug' in b) {
    if (b.parent_slug === null || b.parent_slug === '') patch.parent_slug = null
    else if (typeof b.parent_slug === 'string') {
      const slug = generateSlug(b.parent_slug)
      if (!slug) return { ok: false, error: 'That parent has no letters or numbers to make a web address from.' }
      patch.parent_slug = slug
    } else return { ok: false, error: 'parent_slug must be text.' }
  }
  if ('review_state' in b) {
    if (b.review_state === null) patch.review_state = null
    else if (b.review_state === 'rejected') patch.review_state = 'rejected'
    else return { ok: false, error: 'review_state must be "rejected" or null.' }
  }
  const touched = Object.keys(patch.text).length + ['scope', 'parent_slug', 'review_state'].filter((k) => k in patch).length
  if (touched === 0) return { ok: false, error: 'Nothing to change.' }
  return { ok: true, patch }
}
