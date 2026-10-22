import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { getSettingStrict, setSetting } from '@/lib/app-settings'
import { NEWS_SOURCES } from '@/lib/news-sources'
import { NEWS_SOURCES_OFF_KEY, ingestFeeds, newsTableReady, parseSourcesOff } from '@/lib/news-ingest'
import { readFeedState } from '@/lib/news-feed'
import { getNewsMode, setNewsMode, getNewsPerDay } from '@/lib/news-settings'
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
