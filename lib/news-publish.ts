import type { SupabaseClient } from '@supabase/supabase-js'
import { EST_COST_USD_PER_CALL, type ContentEdit } from '@/lib/content-repair'
import { attachEdits, deleteEdits, editsLoggable, insertEdits } from '@/lib/content-edits'
import { site } from '@/lib/site'
import type { NewsBrief, NewsFacts } from '@/lib/news-brief'
import { NEWS_TAG, buildNewsBody, markSupersededBody, newsSlug, newsTitle } from '@/lib/news-post'
import type { NewsItemRow } from '@/lib/news-ingest'
import { newsCoverAlt, newsCoverUrl } from '@/lib/news-cover'

// Growth loop WP20: saving a news brief as a normal blog post. Reuses the blog (posts table, /blog/<slug>): no new page type,
// no new route. A post goes live only when the caller says so (mode publish AND the brief passed the gate and the judge),
// and every going-live is logged in content_edits BEFORE it happens ("log, then apply"), so Undo on the Self-healing card
// can take it back to a draft. A queued draft is never deleted by anything here.

export interface NewsPostInput {
  item: Pick<NewsItemRow, 'id' | 'title' | 'url' | 'published_at' | 'fetched_at' | 'category'>
  facts: Pick<NewsFacts, 'sourceName'>
  brief: NewsBrief
  /** True: go live now (an audit row is written first). False: save as a draft. */
  publish: boolean
  /** Model calls this item cost, for the audit row's cost estimate. */
  calls: number
  /** True when the strip fallback removed sentences before the brief passed. */
  stripped?: boolean
  /** The older brief of the same storm this one updates; linked from the top of the new post. */
  supersedes?: { title: string; slug: string }
  now: Date
}

export interface NewsPostResult {
  ok: boolean
  slug?: string
  id?: string
  published: boolean
  note: string
}

const todayDate = (now: Date) => now.toISOString().slice(0, 10)

const statusEdit = (slug: string, reason: string, calls: number, id: string | null): ContentEdit => ({
  content_type: 'post',
  content_id: id,
  path: `/blog/${slug}`,
  field: 'status',
  reason,
  before: 'draft',
  after: 'published',
  method: 'generate',
  published_after: true,
  cost_usd: Math.round(calls * EST_COST_USD_PER_CALL * 10000) / 10000,
})

/** The columns of the post a news brief becomes. Pure. */
export function buildNewsPostRow(i: NewsPostInput, phone: string = site.phone ?? ''): Record<string, unknown> {
  const slug = newsSlug(i.brief.headline, i.item.id)
  return {
    title: newsTitle(i.brief.headline),
    slug,
    body: buildNewsBody({ supersedes: i.supersedes, brief: i.brief, sourceName: i.facts.sourceName, url: i.item.url, reportedAt: i.item.published_at ?? i.item.fetched_at, phone }),
    // Every news post gets the branded teal news card (drawn at /og/news/<slug>), never a stock photo: a storm or an advisory
    // is an event, and a beach photo can show the wrong place. Alt text is the headline. Set for drafts too, so going live later
    // needs no extra step (the card shows once the post is published; the admin thumbnail falls back to the default until then).
    cover_image_url: newsCoverUrl(slug),
    alt_text: newsCoverAlt(i.brief.headline),
    tags: [NEWS_TAG, i.item.category],
    related_package_id: null,
    status: i.publish ? 'published' : 'draft',
    publish_date: i.publish ? todayDate(i.now) : null,
    meta_title: null,
    meta_description: i.brief.happened,
    // The first key takeaway is the hook of the social caption (lib/social-captions.ts reads it): the brief's first sentence.
    key_takeaways: [i.brief.happened],
    og_description: i.brief.happened,
  }
}

const SEO_COLUMNS = ['key_takeaways', 'og_description']

/** Inserts the post. If migration 0027's columns are missing it retries without them, like createPost does. */
async function insertPostRow(admin: SupabaseClient, row: Record<string, unknown>): Promise<{ id?: string; error?: string }> {
  let { data, error } = await admin.from('posts').insert(row).select('id').single()
  if (error && /column|schema cache/i.test(error.message)) {
    const base = { ...row }
    for (const c of SEO_COLUMNS) delete base[c]
    ;({ data, error } = await admin.from('posts').insert(base).select('id').single())
  }
  if (error) return { error: error.message }
  return { id: (data as { id: string } | null)?.id }
}

/** Saves one brief as a post: published (audit row first) or as a draft. Never throws. */
export async function createNewsPost(admin: SupabaseClient, input: NewsPostInput): Promise<NewsPostResult> {
  try {
    const row = buildNewsPostRow(input)
    const slug = String(row.slug)
    const { data: clash } = await admin.from('posts').select('id').eq('slug', slug).maybeSingle()
    if (clash) return { ok: false, slug, published: false, note: 'a post with this address already exists' }

    let publish = input.publish
    let logIds: string[] = []
    let note = ''
    if (publish) {
      if (!(await editsLoggable(admin))) {
        // No audit log, no going live: the brief is kept as a draft and the item stays queued.
        publish = false
        row.status = 'draft'
        row.publish_date = null
        note = 'saved as a draft because the edit log (migration 0033) is not set up'
      } else {
        const logged = await insertEdits(admin, [statusEdit(slug, `a travel news brief passed the checks${input.stripped ? ' (after a sentence was removed)' : ''} and went live automatically`, input.calls, null)])
        if (logged.error) {
          publish = false
          row.status = 'draft'
          row.publish_date = null
          note = `saved as a draft because the edit log could not be written (${logged.error})`
        } else logIds = logged.ids
      }
    }
    const saved = await insertPostRow(admin, row)
    if (saved.error || !saved.id) {
      await deleteEdits(admin, logIds).catch(() => undefined)
      return { ok: false, slug, published: false, note: `the post could not be saved (${saved.error ?? 'no id'})` }
    }
    if (logIds.length) await attachEdits(admin, logIds, { content_id: saved.id, path: `/blog/${slug}`, published_after: true })
    return { ok: true, slug, id: saved.id, published: publish, note: note || (publish ? 'published' : 'saved as a draft') }
  } catch (e) {
    return { ok: false, published: false, note: `the post could not be saved (${e instanceof Error ? e.message : 'unexpected error'})` }
  }
}

/** Marks an older LIVE storm brief with an "Update: superseded" heading line that links the newer one. The change is logged in
 * content_edits first (field body, so Undo puts the old text back) and only a published post is touched. Returns whether it
 * was marked. Never throws. */
export async function markSuperseded(admin: SupabaseClient, oldSlug: string, newer: { title: string; slug: string }): Promise<boolean> {
  try {
    const { data } = await admin.from('posts').select('id, body, status').eq('slug', oldSlug).maybeSingle()
    const p = data as { id: string; body: string; status: string } | null
    if (!p || p.status !== 'published') return false
    const next = markSupersededBody(p.body, newer.title, newer.slug)
    if (next === p.body || !(await editsLoggable(admin))) return false
    const logged = await insertEdits(admin, [
      // published_after is false on purpose: undoing this text change must never unpublish the post.
      { content_type: 'post', content_id: p.id, path: `/blog/${oldSlug}`, field: 'body', reason: 'a newer bulletin of the same storm went live, so this brief is marked superseded', before: p.body, after: next, method: 'generate', published_after: false, cost_usd: 0 },
    ])
    if (logged.error) return false
    const { error } = await admin.from('posts').update({ body: next, updated_at: new Date().toISOString() }).eq('id', p.id)
    if (error) {
      await deleteEdits(admin, logged.ids).catch(() => undefined)
      return false
    }
    return true
  } catch {
    return false
  }
}

/** Takes a queued draft live (mode was switched to publish). The audit row is written first; the draft is changed only if
 * the row is still a draft. Returns whether it went live. Never throws. */
export async function publishQueuedDraft(admin: SupabaseClient, slug: string, calls: number, now: Date): Promise<{ ok: boolean; note: string }> {
  try {
    if (!(await editsLoggable(admin))) return { ok: false, note: 'the edit log (migration 0033) is not set up, so the draft stays a draft' }
    const { data: post } = await admin.from('posts').select('id, status').eq('slug', slug).maybeSingle()
    const p = post as { id: string; status: string } | null
    if (!p) return { ok: false, note: 'the draft post no longer exists' }
    if (p.status !== 'draft') return { ok: false, note: `the post is already ${p.status}` }
    const logged = await insertEdits(admin, [statusEdit(slug, 'a queued travel news brief that had passed the checks was published when news publishing was switched on', calls, p.id)])
    if (logged.error) return { ok: false, note: `the edit log could not be written (${logged.error})` }
    const { error } = await admin.from('posts').update({ status: 'published', publish_date: todayDate(now), updated_at: now.toISOString() }).eq('id', p.id).eq('status', 'draft')
    if (error) {
      await deleteEdits(admin, logged.ids).catch(() => undefined)
      return { ok: false, note: `could not publish the draft (${error.message})` }
    }
    return { ok: true, note: 'published' }
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : 'unexpected error' }
  }
}
