import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { policyKey, policyEnabled, readDecisions, SEO_POLICIES, POLICY_LABELS, POLICY_CAPS, setPolicySwitch } from '@/lib/auto-decisions'
import { getSettingStrict } from '@/lib/app-settings'
import { readMiningState, proposalBlockReason, topicAngle, topicWhy } from '@/lib/gsc-mining'
import { readCannibalState } from '@/lib/cannibalization'
import { readHubSpokeState } from '@/lib/hub-spoke'
import { addCompetitor, removeCompetitor, readCompetitorList, readCompetitorState, writeCompetitorList, CANNOT_READ, MANUAL_STEPS, MAX_COMPETITORS } from '@/lib/competitor-scan'
import { competitorTasks } from '@/lib/competitor-tasks'
import type { PostFact } from '@/lib/blog-topics'

export const dynamic = 'force-dynamic'

// The SEO engines page: GET reads the four stored results and the automatic decisions the engines made (newest first). POST does exactly four
// small things, all by an admin click: send one proposed topic to the topic queue (as "suggested", never approved or written), add or remove a
// competitor address, and flip an engine's on/off switch. Undo for an automatic link or topic is the Autopilot decisions route.
export async function GET(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const admin = getSupabaseAdmin()
    const [mining, cannibal, hubspoke, list, compState, log] = await Promise.all([readMiningState(admin), readCannibalState(admin), readHubSpokeState(admin), readCompetitorList(admin), readCompetitorState(admin), readDecisions(admin)])
    const switches = await Promise.all(
      SEO_POLICIES.map(async (policy) => {
        const r = await getSettingStrict(admin, policyKey(policy))
        return { policy, label: POLICY_LABELS[policy], cap: POLICY_CAPS[policy], on: r.error ? true : policyEnabled(r.value), readable: !r.error }
      }),
    )
    return NextResponse.json({
      mining,
      cannibal,
      hubspoke,
      competitors: { list, state: compState.competitors, max: MAX_COMPETITORS, tasks: competitorTasks(list), manualSteps: MANUAL_STEPS, cannotRead: CANNOT_READ },
      decisions: [...log].reverse().filter((d) => (SEO_POLICIES as readonly string[]).includes(d.policy)).slice(0, 25),
      switches,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await request.json().catch(() => ({}))
    const admin = getSupabaseAdmin()

    if (body.action === 'send-topic') {
      if (typeof body.id !== 'string') return NextResponse.json({ error: 'id is required' }, { status: 400 })
      const mining = await readMiningState(admin)
      const p = mining.proposals.find((x) => x.id === body.id)
      if (!p) return NextResponse.json({ error: 'That proposal is no longer in the list.' }, { status: 404 })
      if (p.pageType !== 'blog') return NextResponse.json({ error: `This one is best answered by ${p.pageType === 'guide' ? 'a guide page' : 'another kind of page'}, not a blog post, so it cannot go to the blog topic queue.` }, { status: 409 })
      const [{ data: queue, error: qErr }, { data: posts, error: pErr }] = await Promise.all([
        admin.from('blog_topic_queue').select('keyword, keywords').limit(2000),
        admin.from('posts').select('slug, title, primary_keyword, secondary_keywords, tags, body, publish_date, created_at, related_package_id').limit(1000),
      ])
      if (qErr || pErr) return NextResponse.json({ error: 'Could not read the topic queue or the posts.' }, { status: 500 })
      const why = proposalBlockReason(p, (queue ?? []) as { keyword: string; keywords?: string[] | null }[], (posts ?? []) as PostFact[])
      if (why) return NextResponse.json({ error: `Not sent: ${why}.` }, { status: 409 })
      const row = { angle: topicAngle(p), keyword: p.primary, why: topicWhy(p), source: 'seo-engines (sent by hand)', keywords: [p.primary, ...p.queries.map((q) => q.query).filter((q) => q !== p.primary)].slice(0, 6), status: 'suggested' as const }
      const { error } = await admin.from('blog_topic_queue').insert(row)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, message: 'Sent to the topic queue as a suggestion. Nothing is written until you approve it there.' })
    }

    if (body.action === 'competitor-add') {
      const list = await readCompetitorList(admin)
      const r = addCompetitor(list, typeof body.url === 'string' ? body.url : '')
      if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 })
      const w = await writeCompetitorList(admin, r.list)
      if (w.error) return NextResponse.json({ error: w.error }, { status: 500 })
      return NextResponse.json({ ok: true, list: r.list })
    }

    if (body.action === 'competitor-remove') {
      const list = await readCompetitorList(admin)
      const next = removeCompetitor(list, typeof body.url === 'string' ? body.url : '')
      const w = await writeCompetitorList(admin, next)
      if (w.error) return NextResponse.json({ error: w.error }, { status: 500 })
      return NextResponse.json({ ok: true, list: next })
    }

    if (body.action === 'switch') {
      if (!(SEO_POLICIES as readonly string[]).includes(body.policy) || typeof body.on !== 'boolean') return NextResponse.json({ error: 'policy (seo_topics or seo_links) and on (true or false) are required' }, { status: 400 })
      const { error } = await setPolicySwitch(admin, body.policy, body.on)
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ ok: true, policy: body.policy, on: body.on })
    }

    return NextResponse.json({ error: 'Nothing to do - pass {action: "send-topic", id}, {action: "competitor-add", url}, {action: "competitor-remove", url} or {action: "switch", policy, on}.' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
