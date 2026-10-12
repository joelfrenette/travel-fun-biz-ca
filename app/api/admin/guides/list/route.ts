import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { GUIDE_KINDS, guideKinds, guidePath, isGuideKind, setGuideStatus, isMissingScopeColumn, type GuideKind } from '@/lib/guides'
import { parseScope, SCOPE_LABEL, GUIDE_SCOPES, scopeOf } from '@/lib/guide-scope'
import { bulkPublishable, parseListQuery, queryGuideRows, wordCountOf, inReviewQueue, type GuideListRow } from '@/lib/guide-list'
import { inboundCounts, loadPostsAndTrips, toAuditGuides, type AuditGuide } from '@/lib/guide-orphans'
import { enrollGuideIfDue } from '@/lib/guide-distribution'
import { pingIndexNow } from '@/lib/indexnow'
import { PERFORMANCE_TABLE } from '@/lib/content-performance'

export const maxDuration = 60

type DbRow = {
  id: string
  kind: string
  slug: string
  name: string
  parent_slug: string | null
  scope?: string | null
  status: 'draft' | 'published'
  source: 'ai' | 'manual'
  review_state?: string | null
  quality_notes: string | null
  updated_at: string
  summary: string | null
  body: string | null
  seo_score?: number | null
  primary_keyword: string | null
  related_package_ids: string[] | null
}

/** Search Console clicks (trailing 28 days) per page path from the newest performance snapshot. Empty when none exists. */
async function latestClicks(admin: ReturnType<typeof getSupabaseAdmin>, paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (paths.length === 0) return out
  try {
    const { data: newest } = await admin.from(PERFORMANCE_TABLE).select('day').order('day', { ascending: false }).limit(1).maybeSingle()
    const day = (newest as { day: string } | null)?.day
    if (!day) return out
    for (let i = 0; i < paths.length; i += 200) {
      const { data } = await admin.from(PERFORMANCE_TABLE).select('path, clicks').eq('day', day).in('path', paths.slice(i, i + 200))
      for (const r of (data ?? []) as { path: string; clicks: number | null }[]) if (typeof r.clicks === 'number') out.set(r.path, r.clicks)
    }
  } catch {
    // no clicks column to show
  }
  return out
}

// GET /api/admin/guides/list?q=&sort=&dir=&kind=&scope=&status=&page=&pageSize=
// Every guide in one searchable, sortable, filterable, paged list. Search, sort, filters and paging all happen on the
// server (lib/guide-list.ts), so the browser only ever receives one page of rows.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const query = parseListQuery(new URL(request.url).searchParams, GUIDE_KINDS)
    const [{ data, error }, extras] = await Promise.all([admin.from('guides').select('*'), loadPostsAndTrips(admin)])
    if (error) return NextResponse.json({ error: `Could not read guides: ${error.message}` }, { status: 500 })
    const rows = (data ?? []) as DbRow[]
    const published = toAuditGuides(rows.filter((r) => r.status === 'published') as unknown as AuditGuide[])
    // Inbound links need the posts and trips too. If they cannot be read the column shows a dash, never a made-up zero.
    const inbound = extras ? inboundCounts(published, extras.posts, extras.trips) : null
    const clicks = await latestClicks(admin, rows.filter((r) => r.status === 'published' && isGuideKind(r.kind)).map((r) => guidePath(r.kind as GuideKind, r.slug)))

    const list: GuideListRow[] = rows
      .filter((r) => isGuideKind(r.kind))
      .map((r) => {
        const path = guidePath(r.kind as GuideKind, r.slug)
        return {
          id: r.id,
          kind: r.kind,
          slug: r.slug,
          name: r.name,
          parent_slug: r.parent_slug,
          scope: parseScope(r.scope),
          status: r.status,
          source: r.source,
          review_state: r.review_state === 'rejected' ? 'rejected' : null,
          quality_notes: r.quality_notes,
          updated_at: r.updated_at,
          words: wordCountOf(r.summary ?? '', r.body ?? ''),
          score: typeof r.seo_score === 'number' ? r.seo_score : null,
          inbound: r.status === 'published' ? (inbound?.get(`${r.kind}:${r.slug}`) ?? -1) : 0,
          clicks: clicks.get(path) ?? null,
          path,
          primary_keyword: r.primary_keyword,
        }
      })

    const result = queryGuideRows(list, query, (k) => (isGuideKind(k) ? guideKinds[k].plural : k))
    return NextResponse.json({
      ...result,
      query,
      inboundKnown: inbound !== null,
      kinds: GUIDE_KINDS.map((k) => ({ kind: k, label: guideKinds[k].plural })),
      scopes: GUIDE_SCOPES.map((s) => ({ scope: s, label: SCOPE_LABEL[s] })),
      shownScope: Object.fromEntries(result.rows.map((r) => [r.id, scopeOf(r)])),
      needsMigration: rows.length > 0 && !('scope' in rows[0]),
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// POST { action: 'publish' | 'reject' | 'restore', ids: string[] }   (at most 100 ids)
//   publish: drafts only, and only drafts the checks did not hold back (see bulkPublishable); the rest come back under `skipped`
//   reject:  drafts only: marks them rejected so they leave the review queue (needs migration 0041)
//   restore: puts rejected drafts back into the review queue
// There is deliberately no bulk unpublish and no bulk delete: taking a live page down is one page at a time.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const ids: string[] = Array.isArray(body.ids) ? [...new Set((body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))] : []
    if (ids.length === 0) return NextResponse.json({ error: 'Pick at least one page.' }, { status: 400 })
    if (ids.length > 100) return NextResponse.json({ error: 'Pick 100 pages or fewer at a time.' }, { status: 400 })
    if (body.action !== 'publish' && body.action !== 'reject' && body.action !== 'restore') return NextResponse.json({ error: 'action must be "publish", "reject" or "restore".' }, { status: 400 })

    const admin = getSupabaseAdmin()
    const { data, error } = await admin.from('guides').select('*').in('id', ids)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const rows = (data ?? []) as DbRow[]

    if (body.action === 'publish') {
      const { ok, skipped } = bulkPublishable(rows.map((r) => ({ id: r.id, name: r.name, status: r.status, quality_notes: r.quality_notes, review_state: r.review_state === 'rejected' ? 'rejected' : null })))
      const published: string[] = []
      const failed: { id: string; error: string }[] = []
      const paths: string[] = []
      for (const id of ok) {
        const r = await setGuideStatus(admin, id, 'published')
        if (r.error || !r.guide) {
          failed.push({ id, error: r.error ?? 'could not publish' })
          continue
        }
        published.push(id)
        paths.push(guidePath(r.guide.kind, r.guide.slug))
        await enrollGuideIfDue(admin, r.guide)
      }
      if (paths.length) await pingIndexNow([...paths, '/sitemap.xml']).catch(() => undefined)
      return NextResponse.json({ ok: failed.length === 0, published: published.length, skipped, failed })
    }

    const drafts = rows.filter((r) => r.status === 'draft')
    const wanted = body.action === 'reject' ? drafts.filter(inReviewQueueRow) : drafts.filter((r) => r.review_state === 'rejected')
    const skipped = rows.filter((r) => !wanted.includes(r)).map((r) => ({ id: r.id, name: r.name, reason: r.status === 'published' ? 'live pages are never rejected here' : body.action === 'reject' ? 'not waiting for review' : 'not rejected' }))
    if (wanted.length === 0) return NextResponse.json({ ok: true, changed: 0, skipped })
    const { error: updateError } = await admin
      .from('guides')
      .update({ review_state: body.action === 'reject' ? 'rejected' : null, updated_at: new Date().toISOString() })
      .in('id', wanted.map((r) => r.id))
    if (updateError) {
      const needs = isMissingScopeColumn(updateError.message) ? ' Apply migration 0041 (supabase/migrations/0041_guide_scope.sql) first.' : ''
      return NextResponse.json({ error: `${updateError.message}.${needs}` }, { status: isMissingScopeColumn(updateError.message) ? 409 : 500 })
    }
    return NextResponse.json({ ok: true, changed: wanted.length, skipped })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

function inReviewQueueRow(r: DbRow): boolean {
  return inReviewQueue({ status: r.status, source: r.source, review_state: r.review_state === 'rejected' ? 'rejected' : null })
}
