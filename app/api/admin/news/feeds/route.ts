import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { NEWS_SOURCES } from '@/lib/news-sources'
import { NEWS_SOURCES_OFF_KEY, ingestFeeds, newsTableReady, parseSourcesOff } from '@/lib/news-ingest'
import { readFeedState } from '@/lib/news-feed'
import { getNewsMode, setNewsMode, getNewsPerDay } from '@/lib/news-settings'
import { enrollNewsIfDue } from '@/lib/news-distribution'
import { revalidateBlog } from '@/lib/blog-revalidate'
import { pingIndexNow } from '@/lib/indexnow'
import { applySourceToggle, sourceHealth, sourceTypeLabel } from '@/lib/news-admin'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ITEM_LIMIT = 500

// Read everything the News screen shows. Read only: no feed is fetched here.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [mode, perDay, offRaw] = await Promise.all([getNewsMode(admin), getNewsPerDay(admin), getSettingStrict(admin, NEWS_SOURCES_OFF_KEY)])
    const off = parseSourcesOff(offRaw.value)

    // Items table (newest first) and per-source totals. The table may not exist until migration 0047 is applied.
    let items: unknown[] = []
    let tableProblem: string | undefined
    const seenBySource: Record<string, number> = {}
    const statusTotals: Record<string, number> = {}
    const ready = await newsTableReady(admin)
    if (!ready.ok) {
      tableProblem = ready.error
    } else {
      const list = await admin
        .from('news_items')
        .select('id, source_key, title, url, status, category, tier, published_at, fetched_at, reject_reason, post_slug')
        .order('fetched_at', { ascending: false })
        .limit(ITEM_LIMIT)
      if (list.error) tableProblem = list.error.message
      else items = list.data ?? []
      // Totals come from a light two-column read so they are not capped at the 500 listed rows (cap 10000).
      const light = await admin.from('news_items').select('source_key, status').limit(10000)
      if (!light.error) {
        for (const r of (light.data ?? []) as { source_key: string; status: string }[]) {
          seenBySource[r.source_key] = (seenBySource[r.source_key] ?? 0) + 1
          statusTotals[r.status] = (statusTotals[r.status] ?? 0) + 1
        }
      }
    }

    const sources = await Promise.all(
      NEWS_SOURCES.map(async (s) => {
        const st = await readFeedState(admin, s.key)
        const isOff = off.has(s.key)
        return {
          key: s.key,
          name: s.name.replace(/^the /i, ''),
          type: s.kind === 'json' ? 'json' : 'feed',
          typeLabel: sourceTypeLabel(s.kind),
          url: s.feedUrl,
          tier: s.tier,
          enabledInCode: s.enabled,
          off: isOff,
          lastFetchAt: st.lastFetchAt ?? null,
          lastOkAt: st.lastOkAt ?? null,
          fails: st.fails,
          lastError: st.lastError ?? null,
          itemsSeen: seenBySource[s.key] ?? 0,
          health: s.enabled ? sourceHealth(isOff, st) : 'off',
        }
      }),
    )
    return NextResponse.json({ mode, perDay, sources, items, statusTotals, tableProblem, offSettingError: offRaw.error ?? null })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

// Writes: the mode selector, a per-source ON/OFF switch, and the free "Fetch feeds now" read.
export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.action === 'mode') {
      if (!['off', 'draft', 'publish'].includes(body.mode)) return NextResponse.json({ error: 'mode must be off, draft or publish' }, { status: 400 })
      const { error } = await setNewsMode(admin, body.mode)
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ mode: body.mode })
    }

    if (body.action === 'source') {
      const known = NEWS_SOURCES.some((s) => s.key === body.key)
      if (!known) return NextResponse.json({ error: 'unknown source' }, { status: 400 })
      if (typeof body.off !== 'boolean') return NextResponse.json({ error: 'off must be true or false' }, { status: 400 })
      // A failed read must not be mistaken for "nothing is off": writing then would silently switch other sources back on.
      const current = await getSettingStrict(admin, NEWS_SOURCES_OFF_KEY)
      if (current.error) return NextResponse.json({ error: `could not read the current setting: ${current.error}` }, { status: 500 })
      const next = applySourceToggle(current.value, body.key, body.off)
      if (next === null) return NextResponse.json({ error: 'invalid source key' }, { status: 400 })
      const { error } = await setSetting(admin, NEWS_SOURCES_OFF_KEY, next)
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ key: body.key, off: body.off, value: next })
    }

    // Reject: marks one feed item rejected so the writer never picks it up again. It does not touch any post: a draft brief that
    // already exists stays a draft (delete it from the list if it is not wanted). A published item cannot be rejected here.
    if (body.action === 'reject') {
      if (typeof body.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(body.id)) return NextResponse.json({ error: 'id must be a news item id' }, { status: 400 })
      const { data: item, error: readError } = await admin.from('news_items').select('id, status').eq('id', body.id).maybeSingle()
      if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })
      if (!item) return NextResponse.json({ error: 'news item not found' }, { status: 404 })
      if ((item as { status: string }).status === 'published') return NextResponse.json({ error: 'this item is already published; unpublish the post instead' }, { status: 409 })
      const { error } = await admin.from('news_items').update({ status: 'rejected', reject_reason: 'rejected by an admin', decided_at: new Date().toISOString() }).eq('id', body.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ id: body.id, status: 'rejected' })
    }

    // Approve and publish: takes one DRAFT news brief live (the owner has looked at it), marks its feed item published, then does
    // what the scheduled run does after going live: one social enrolment through the news ledger (a no-op while distribution is off
    // or paused) and an IndexNow ping.
    if (body.action === 'approve') {
      if (typeof body.slug !== 'string' || !/^[a-z0-9-]{3,200}$/.test(body.slug)) return NextResponse.json({ error: 'slug must be a post slug' }, { status: 400 })
      const slug: string = body.slug
      const { data: item, error: itemError } = await admin.from('news_items').select('id, status').eq('post_slug', slug).limit(1).maybeSingle()
      if (itemError) return NextResponse.json({ error: itemError.message }, { status: 500 })
      if (!item) return NextResponse.json({ error: 'no news item is linked to that post, so it is not a news brief' }, { status: 404 })
      const { data: post, error: postError } = await admin.from('posts').select('id, title, status, publish_date').eq('slug', slug).maybeSingle()
      if (postError) return NextResponse.json({ error: postError.message }, { status: 500 })
      const p = post as { id: string; title: string; status: string; publish_date: string | null } | null
      if (!p) return NextResponse.json({ error: 'the post no longer exists' }, { status: 404 })
      if (p.status !== 'draft') return NextResponse.json({ error: `the post is already ${p.status}` }, { status: 409 })
      const now = new Date()
      const { data: updated, error } = await admin
        .from('posts')
        .update({ status: 'published', publish_date: p.publish_date ?? now.toISOString().slice(0, 10), updated_at: now.toISOString() })
        .eq('id', p.id)
        .eq('status', 'draft')
        .select('*')
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!updated) return NextResponse.json({ error: 'the post changed while you were approving it; reload and try again' }, { status: 409 })
      await admin.from('news_items').update({ status: 'published', reject_reason: null, decided_at: now.toISOString() }).eq('id', (item as { id: string }).id)
      revalidateBlog([slug])
      const perDay = await getNewsPerDay(admin)
      const social = perDay === null ? 'skipped' : await enrollNewsIfDue(admin, { slug, title: p.title, status: 'published' }, perDay)
      await pingIndexNow([`/blog/${slug}`, '/blog', '/']).catch(() => undefined)
      return NextResponse.json({ post: updated, social })
    }

    if (body.action === 'fetch') {
      // The same free RSS read the scheduled pipeline does: no AI call, nothing published. Each feed is still read at most once
      // per 30 minutes and robots.txt is respected. Refused while the news mode is off (off means nothing is read).
      if ((await getNewsMode(admin)) === 'off') return NextResponse.json({ error: 'News is off, so no feed is read. Switch the mode to Draft first.' }, { status: 409 })
      const result = await ingestFeeds(admin, { deadlineMs: Date.now() + 50_000 })
      return NextResponse.json({ result })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
