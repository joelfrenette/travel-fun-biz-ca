// A small in-memory stand-in for the parts of the Supabase client the WP18 checks use. No network, no database.
// Supports select / insert / update / delete with eq, neq, gt, gte, lt, lte, in, like, ilike, is, not, order, limit,
// maybeSingle / single, insert-then-select, a unique key on app_settings.key, and the merge_variant_tags rpc.
import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>
export interface Db {
  tables: Record<string, Row[]>
  /** table names whose every write fails with this message (to prove "log, then apply" and fail-closed paths). */
  failWrites?: Record<string, string>
  /** a function that may veto an insert with an error (for example a missing check constraint). */
  rejectInsert?: (table: string, row: Row) => string | null
}

let counter = 0
const valueAt = (r: Row, col: string): unknown => {
  if (col.includes('->>')) {
    const [base, key] = col.split('->>')
    const obj = r[base] as Row | null | undefined
    return obj && typeof obj === 'object' ? (obj as Row)[key] : undefined
  }
  return r[col]
}

export function fakeAdmin(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
    let upsertOn: string[] = ['id']
    let payload: Row[] = []
    let patch: Row = {}
    let head = false
    let wantRows = true
    let orderBy: { col: string; asc: boolean } | null = null
    let max = Infinity
    let offset = 0
    const rows = () => (db.tables[table] ??= [])
    const run = (): { data: Row[] | null; error: { message: string; code?: string } | null; count: number | null } => {
      if (mode !== 'select' && db.failWrites?.[table]) return { data: null, error: { message: db.failWrites[table] }, count: null }
      if (mode === 'upsert') {
        const touched: Row[] = []
        for (const p of payload) {
          const existing = rows().find((r) => upsertOn.every((c) => r[c] === p[c]))
          if (existing) {
            Object.assign(existing, p)
            touched.push(existing)
          } else {
            const row: Row = { id: `id-${++counter}`, created_at: new Date().toISOString(), ...p }
            rows().push(row)
            touched.push(row)
          }
        }
        return { data: wantRows ? touched : null, error: null, count: touched.length }
      }
      if (mode === 'insert') {
        const inserted: Row[] = []
        for (const p of payload) {
          const veto = db.rejectInsert?.(table, p)
          if (veto) return { data: null, error: { message: veto }, count: null }
          if (table === 'app_settings' && rows().some((r) => r.key === p.key)) return { data: null, error: { message: 'duplicate key', code: '23505' }, count: null }
          const row: Row = { id: `id-${++counter}`, created_at: new Date().toISOString(), ...p }
          rows().push(row)
          inserted.push(row)
        }
        return { data: wantRows ? inserted : null, error: null, count: inserted.length }
      }
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, patch)
        return { data: wantRows ? hit : null, error: null, count: hit.length }
      }
      if (mode === 'delete') {
        db.tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: null, error: null, count: hit.length }
      }
      let out = [...hit]
      if (orderBy) {
        const { col, asc } = orderBy
        out.sort((a, b) => (String(valueAt(a, col) ?? '') < String(valueAt(b, col) ?? '') ? (asc ? -1 : 1) : String(valueAt(a, col) ?? '') > String(valueAt(b, col) ?? '') ? (asc ? 1 : -1) : 0))
      }
      out = out.slice(offset, offset + max)
      return { data: head ? null : out.map((r) => ({ ...r })), error: null, count: hit.length }
    }
    const q: Record<string, unknown> = {
      select: (_cols?: string, o?: { head?: boolean }) => {
        if (mode === 'insert' || mode === 'update' || mode === 'upsert') wantRows = true
        head = !!o?.head
        return q
      },
      insert: (row: Row | Row[]) => {
        mode = 'insert'
        payload = Array.isArray(row) ? row : [row]
        wantRows = false
        return q
      },
      // Like Supabase: a row whose conflict column(s) match an existing row UPDATES it; otherwise it is inserted.
      upsert: (row: Row | Row[], o?: { onConflict?: string }) => {
        mode = 'upsert'
        payload = Array.isArray(row) ? row : [row]
        upsertOn = (o?.onConflict ?? 'id').split(',').map((c) => c.trim())
        wantRows = false
        return q
      },
      update: (p: Row) => {
        mode = 'update'
        patch = p
        wantRows = false
        return q
      },
      delete: () => ((mode = 'delete'), q),
      eq: (c: string, v: unknown) => (filters.push((r) => valueAt(r, c) === v), q),
      match: (o: Row) => {
        for (const [c, v] of Object.entries(o)) filters.push((r) => valueAt(r, c) === v)
        return q
      },
      neq: (c: string, v: unknown) => (filters.push((r) => valueAt(r, c) !== v), q),
      gt: (c: string, v: string) => (filters.push((r) => valueAt(r, c) != null && String(valueAt(r, c)) > v), q),
      gte: (c: string, v: string) => (filters.push((r) => valueAt(r, c) != null && String(valueAt(r, c)) >= v), q),
      lt: (c: string, v: string) => (filters.push((r) => valueAt(r, c) != null && String(valueAt(r, c)) < v), q),
      lte: (c: string, v: string) => (filters.push((r) => valueAt(r, c) != null && String(valueAt(r, c)) <= v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(valueAt(r, c))), q),
      like: (c: string, pat: string) => {
        const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`)
        filters.push((r) => re.test(String(valueAt(r, c) ?? '')))
        return q
      },
      ilike: (c: string, pat: string) => {
        const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
        filters.push((r) => re.test(String(valueAt(r, c) ?? '')))
        return q
      },
      is: (c: string, v: unknown) => (filters.push((r) => (v === null ? valueAt(r, c) == null : valueAt(r, c) === v)), q),
      not: (c: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) filters.push((r) => valueAt(r, c) != null)
        return q
      },
      order: (col: string, o?: { ascending?: boolean }) => ((orderBy = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((max = n), q),
      range: (from: number, to: number) => ((offset = from), (max = to - from + 1), q),
      maybeSingle: () => {
        const r = run()
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error })
      },
      single: () => {
        const r = run()
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? r.error : r.error ?? { message: 'no row' } })
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return q
  }
  const rpc = async (name: string, args: { p_slug?: string; p_patch?: Row }) => {
    if (name !== 'merge_variant_tags') return { data: null, error: { message: `unknown rpc ${name}` } }
    const list = (db.tables.content_variants ??= [])
    const existing = list.find((r) => r.slug === args.p_slug)
    if (existing) existing.variant_tags = { ...((existing.variant_tags as Row) ?? {}), ...(args.p_patch ?? {}) }
    else list.push({ slug: args.p_slug, variant_tags: { ...(args.p_patch ?? {}) } })
    return { data: null, error: null }
  }
  return { from, rpc } as unknown as SupabaseClient
}
