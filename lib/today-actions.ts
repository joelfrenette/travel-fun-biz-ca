import type { SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from '@/lib/app-settings'
import { resolveIssue, type IssueAction } from '@/lib/issues'
import { VIDEO_BLOCK_KEY } from '@/lib/autopilot'
import { setDistributionStage } from '@/lib/distribution'
import { setTopicStatus } from '@/lib/blog-topics'
import { decideSubmission } from '@/lib/agent-submissions'
import { dismissFindings } from '@/lib/source-watch'
import { todayEt } from '@/lib/ai-verify'
import { DISMISS_ACTIONS, type TodayKindId } from '@/lib/today-cards'
import { TODAY_LEADS_DONE_KEY, addToIdList, parseIdList, removeFromIdList, type TodayOp } from '@/lib/today-state'

// Does the real work for a Today card. Nothing here is new business logic: every branch calls the function or the route
// handler that the older admin screens already use, so a swipe means exactly what the old button meant.

export type Prev = Record<string, string | number | null>
export type ActionResult = { ok: true; message: string; prev?: Prev; noop?: boolean } | { ok: false; status: number; error: string }

const done = (message: string, prev?: Prev): ActionResult => ({ ok: true, message, ...(prev ? { prev } : {}) })
const noop = (message: string): ActionResult => ({ ok: true, message, noop: true })
const fail = (status: number, error: string): ActionResult => ({ ok: false, status, error })

export const AGENT_SEND_BACK_NOTE = 'Thanks for sending this. Please check the dates, price and what is included, then send it again.'

type Handler = (request: Request, ctx: { params: Record<string, string> }) => Promise<Response>

/** Calls an existing route handler in-process with the caller's own Authorization header, so the handler's own
 * isAuthorized check still runs. */
async function callHandler(handler: Handler, request: Request, method: 'POST' | 'PATCH', body: unknown, params: Record<string, string> = {}): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  const auth = request.headers.get('authorization')
  if (auth) headers.set('authorization', auth)
  const res = await handler(new Request('http://internal.local/api/admin', { method, headers, body: JSON.stringify(body) }), { params })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok, status: res.status, json }
}

const errorOf = (json: Record<string, unknown>, fallback: string) => (typeof json.error === 'string' && json.error ? json.error : fallback)

export interface RunInput {
  admin: SupabaseClient
  request: Request
  kind: TodayKindId
  key: string
  /** approve = the primary button, reject = the secondary button. */
  op: Exclude<TodayOp, 'snooze'>
}

async function distributionRow(admin: SupabaseClient, slug: string) {
  const { data } = await admin.from('post_distribution').select('stage, last_error, attempts').eq('content_type', 'post').eq('slug', slug).maybeSingle()
  return data as { stage: string; last_error: string | null; attempts: number | null } | null
}

/** Runs the real action behind a button (mode "run"). Buttons of mode open or keep never get here. */
export async function runCardAction(input: RunInput): Promise<ActionResult> {
  const { admin, request, kind, key, op } = input
  const yes = op === 'approve'

  switch (kind) {
    case 'failed-post': {
      const row = await distributionRow(admin, key)
      if (!row || row.stage !== 'failed') return noop('That post is no longer failed.')
      const prev: Prev = { last_error: row.last_error, attempts: row.attempts ?? 0 }
      if (yes) {
        const err = await resolveIssue(admin, 'retry-post', key)
        return err ? fail(400, err) : done('Queued to try again.', prev)
      }
      const { error } = await admin.from('post_distribution').update({ stage: 'held', updated_at: new Date().toISOString() }).eq('content_type', 'post').eq('slug', key).eq('stage', 'failed')
      return error ? fail(500, error.message) : done('Held. It is on the Post Distribution page.', prev)
    }

    case 'failed-render': {
      const [part, slug] = key.split(':')
      const stageKey = part === 'video' ? 'video_stage' : 'carousel_stage'
      const { data } = await admin.from('content_pipeline').select(`${stageKey}, last_error`).eq('slug', slug).maybeSingle()
      const row = data as unknown as Record<string, string | null> | null
      if (!row || row[stageKey] !== 'failed') return noop('That is no longer failed.')
      const prev: Prev = { part, last_error: row.last_error ?? null }
      const err = await resolveIssue(admin, `${yes ? 'retry' : 'dismiss'}-${part}` as IssueAction, slug)
      return err ? fail(400, err) : done(yes ? `The ${part} is queued to be made again.` : `Skipped the ${part}.`, prev)
    }

    case 'video-paused': {
      const prev: Prev = { value: (await getSetting(admin, VIDEO_BLOCK_KEY)) ?? '' }
      const err = await resolveIssue(admin, 'resume-video')
      return err ? fail(400, err) : done('Videos are resumed.', prev)
    }

    case 'lead-reply': {
      const list = parseIdList(await getSetting(admin, TODAY_LEADS_DONE_KEY))
      const { error } = await setSetting(admin, TODAY_LEADS_DONE_KEY, JSON.stringify(addToIdList(list, key)))
      return error ? fail(500, error) : done(yes ? 'Marked as answered.' : 'Marked as not a real lead.', {})
    }

    case 'agent-submission': {
      const r = await decideSubmission(admin, key, yes ? 'approve' : 'reject', yes ? undefined : AGENT_SEND_BACK_NOTE)
      if (!r.ok) {
        if (r.status === 409) return noop(r.error)
        return fail(r.status, r.error)
      }
      return done(yes ? 'Approved. The trip is live.' : 'Sent back to the agent with a note.')
    }

    case 'news-draft': {
      const mod = await import('@/app/api/admin/news/feeds/route')
      if (yes) {
        const r = await callHandler(mod.POST as unknown as Handler, request, 'POST', { action: 'approve', slug: key })
        if (r.status === 409) return noop(errorOf(r.json, 'That brief was already decided.'))
        return r.ok ? done('Approved and published.') : fail(r.status, errorOf(r.json, 'Could not publish.'))
      }
      const { data } = await admin.from('news_items').select('id, status').eq('post_slug', key).limit(1).maybeSingle()
      const item = data as { id: string; status: string } | null
      if (!item) return fail(404, 'No news item is linked to that draft.')
      const r = await callHandler(mod.POST as unknown as Handler, request, 'POST', { action: 'reject', id: item.id })
      if (r.status === 409) return noop(errorOf(r.json, 'That item was already decided.'))
      return r.ok ? done('Rejected. The writer will not pick it again.', { itemId: item.id, status: item.status }) : fail(r.status, errorOf(r.json, 'Could not reject.'))
    }

    case 'held-post':
    case 'held-guide-post':
    case 'guide-caption-held': {
      // Only the primary button runs; "keep it held" is a plain hide (mode keep).
      const row = await distributionRow(admin, key)
      if (!row || row.stage !== 'held') return noop('That post is no longer held.')
      await setDistributionStage(admin, key, 'queued')
      return done('Approved. It goes out on the next posting pass.', { last_error: row.last_error })
    }

    case 'topic': {
      const { data } = await admin.from('blog_topic_queue').select('status').eq('id', key).maybeSingle()
      const row = data as { status: string } | null
      if (!row) return fail(404, 'That topic is gone.')
      if (row.status !== 'suggested') return noop(`That topic is already ${row.status}.`)
      await setTopicStatus(admin, key, yes ? 'approved' : 'rejected')
      return done(yes ? 'Topic approved.' : 'Topic rejected.', { status: 'suggested' })
    }

    case 'guide-review': {
      const mod = await import('@/app/api/admin/guides/[id]/route')
      const body = yes ? { status: 'published' } : { review_state: 'rejected' }
      const r = await callHandler(mod.PATCH as unknown as Handler, request, 'PATCH', body, { id: key })
      if (r.status === 409 && !yes) return noop(errorOf(r.json, 'Already decided.'))
      return r.ok ? done(yes ? 'Guide published.' : 'Guide rejected. It stays a draft.') : fail(r.status, errorOf(r.json, 'Could not save the guide.'))
    }

    case 'blog-draft': {
      const { data } = await admin.from('posts').select('status, publish_date').eq('id', key).maybeSingle()
      const row = data as { status: string; publish_date: string | null } | null
      if (!row) return fail(404, 'That post is gone.')
      if (row.status === 'published') return noop('That post is already published.')
      const mod = await import('@/app/api/admin/blog/[id]/route')
      const r = await callHandler(mod.PATCH as unknown as Handler, request, 'PATCH', { status: 'published', ...(row.publish_date ? {} : { publish_date: todayEt() }) }, { id: key })
      return r.ok ? done('Published.', { publish_date: row.publish_date }) : fail(r.status, errorOf(r.json, 'Could not publish.'))
    }

    case 'supplier-change': {
      const err = await dismissFindings(admin, key)
      return err ? fail(500, err) : done('Dismissed. The weekly check will tell you if it changes again.')
    }

    case 'issue-dismiss': {
      const [action, ...rest] = key.split(':')
      if (!(DISMISS_ACTIONS as readonly string[]).includes(action)) return fail(400, 'That is not a button a Today card may press.')
      const err = await resolveIssue(admin, action as IssueAction, rest.length ? rest.join(':') : undefined)
      return err ? fail(400, err) : done('Cleared.')
    }

    case 'promote-prompt': {
      const mod = await import('@/app/api/admin/packages/[id]/promote/route')
      const r = await callHandler(mod.POST as unknown as Handler, request, 'POST', { action: 'start' }, { id: key })
      if (r.status === 409) return noop(errorOf(r.json, 'That trip was promoted recently.'))
      return r.ok ? done('Promotion started. Open the trip to follow it.') : fail(r.status, errorOf(r.json, 'Could not start the promotion.'))
    }

    default:
      // recap-prompt, thin-page, affiliate-setup: their buttons only open a page or hide the card.
      return fail(400, 'That card has no action to run.')
  }
}

/** Reverses a run action using what was recorded before it ran. Returns a plain message, or an error. */
export async function undoCardAction(input: { admin: SupabaseClient; request: Request; kind: TodayKindId; key: string; op: Exclude<TodayOp, 'snooze'>; prev?: Prev }): Promise<ActionResult> {
  const { admin, request, kind, key, op } = input
  const prev = input.prev ?? {}
  const now = new Date().toISOString()

  switch (kind) {
    case 'failed-post': {
      const row = await distributionRow(admin, key)
      if (!row || !['queued', 'held'].includes(row.stage)) return fail(409, 'It has already moved on, so it cannot be put back.')
      const { error } = await admin.from('post_distribution').update({ stage: 'failed', last_error: (prev.last_error as string | null) ?? null, attempts: Number(prev.attempts) || 0, updated_at: now }).eq('content_type', 'post').eq('slug', key).in('stage', ['queued', 'held'])
      return error ? fail(500, error.message) : done('Put back as failed.')
    }
    case 'failed-render': {
      const [part, slug] = key.split(':')
      const stageKey = part === 'video' ? 'video_stage' : 'carousel_stage'
      const { error } = await admin.from('content_pipeline').update({ [stageKey]: 'failed', last_error: (prev.last_error as string | null) ?? null, updated_at: now }).eq('slug', slug).in(stageKey, ['pending', 'skipped'])
      return error ? fail(500, error.message) : done('Put back as failed.')
    }
    case 'video-paused': {
      const { error } = await setSetting(admin, VIDEO_BLOCK_KEY, typeof prev.value === 'string' ? prev.value : '')
      return error ? fail(500, error) : done('Videos are paused again.')
    }
    case 'lead-reply': {
      const list = parseIdList(await getSetting(admin, TODAY_LEADS_DONE_KEY))
      const { error } = await setSetting(admin, TODAY_LEADS_DONE_KEY, JSON.stringify(removeFromIdList(list, key)))
      return error ? fail(500, error) : done('The lead is back on the list.')
    }
    case 'news-draft': {
      // Only the reject can be undone (publishing also posts to social and pings search engines).
      if (op !== 'reject' || typeof prev.itemId !== 'string') return fail(409, 'That cannot be undone.')
      const { error } = await admin.from('news_items').update({ status: typeof prev.status === 'string' ? prev.status : 'queued', reject_reason: null, decided_at: null }).eq('id', prev.itemId).eq('status', 'rejected')
      return error ? fail(500, error.message) : done('The news item is back.')
    }
    case 'held-post':
    case 'held-guide-post':
    case 'guide-caption-held': {
      const row = await distributionRow(admin, key)
      if (!row || row.stage !== 'queued') return fail(409, 'It has already gone out, so it cannot be put back.')
      await setDistributionStage(admin, key, 'held')
      if (typeof prev.last_error === 'string' && prev.last_error) await admin.from('post_distribution').update({ last_error: prev.last_error }).eq('content_type', 'post').eq('slug', key)
      return done('Held again.')
    }
    case 'topic': {
      await setTopicStatus(admin, key, 'suggested')
      return done('The topic is back in the list.')
    }
    case 'guide-review': {
      const mod = await import('@/app/api/admin/guides/[id]/route')
      const body = op === 'approve' ? { status: 'draft' } : { review_state: null }
      const r = await callHandler(mod.PATCH as unknown as Handler, request, 'PATCH', body, { id: key })
      return r.ok ? done(op === 'approve' ? 'Unpublished. It is a draft again.' : 'The guide is back in the review queue.') : fail(r.status, errorOf(r.json, 'Could not undo.'))
    }
    case 'blog-draft': {
      const mod = await import('@/app/api/admin/blog/[id]/route')
      const r = await callHandler(mod.PATCH as unknown as Handler, request, 'PATCH', { status: 'draft' }, { id: key })
      return r.ok ? done('Back to a draft. Anything already shared on social stays shared.') : fail(r.status, errorOf(r.json, 'Could not undo.'))
    }
    default:
      return fail(409, 'That cannot be undone.')
  }
}
