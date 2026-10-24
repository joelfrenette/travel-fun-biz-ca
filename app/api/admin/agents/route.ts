import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'
import {
  createProfileLink, decideDraft, decideSubmission, deleteAchievement, deleteAgent, internalLeaderboard, listAchievementsAdmin, listAgentOfMonth,
  listAgentsAdmin, listDrafts, listProfileLinks, listSubmissions, polishAgentBio, previewImport, revokeProfileLink, runImport, saveAchievement,
  saveAgent, setAgentOfMonth, setAgentStatus, suggestMonthAgents,
} from '@/lib/agents-store'
import { parseSheet, type ImportFieldKey, IMPORT_FIELDS } from '@/lib/agents-import'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ADMIN ONLY. Everything about the agent roster, including the private columns (email, phone, notes) and the internal
// leaderboard (sales / commission figures), is served only from here, after isAuthorized().

const unauthorized = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const fail = (e: unknown, status = 500) => NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status })

export async function GET(request: Request) {
  if (!isAuthorized(request)) return unauthorized()
  try {
    const agents = await listAgentsAdmin().catch((e) => {
      throw new Error(/relation|does not exist|schema cache/i.test(String(e?.message)) ? 'MIGRATION' : String(e?.message))
    })
    const [achievements, aotm, submissions, drafts, suggestions, leaderboard] = await Promise.all([
      listAchievementsAdmin(), listAgentOfMonth(), listSubmissions('pending'), listDrafts('draft'), suggestMonthAgents(), internalLeaderboard(),
    ])
    return NextResponse.json({ migrated: true, agents, achievements, aotm, submissions, drafts, suggestions, leaderboard, importFields: IMPORT_FIELDS })
  } catch (e) {
    if (e instanceof Error && e.message === 'MIGRATION') return NextResponse.json({ migrated: false, agents: [], achievements: [], aotm: [], submissions: [], drafts: [], suggestions: [], leaderboard: [], importFields: IMPORT_FIELDS })
    return fail(e)
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return unauthorized()
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const id = typeof body.id === 'string' ? body.id : null
  try {
    switch (body.action) {
      case 'save': {
        const r = await saveAgent(id, (body.agent ?? {}) as Record<string, unknown>)
        return r.ok ? NextResponse.json({ agent: r.agent }) : NextResponse.json({ error: r.errors.join(' ') }, { status: 400 })
      }
      case 'delete': {
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
        const e = await deleteAgent(id)
        return e ? NextResponse.json({ error: e }, { status: 500 }) : NextResponse.json({ ok: true })
      }
      case 'status': {
        if (!id || !['draft', 'ready', 'published'].includes(String(body.status))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
        const r = await setAgentStatus(id, body.status as 'draft' | 'ready' | 'published')
        return r.ok ? NextResponse.json({ ok: true, queued: r.queued }) : NextResponse.json({ error: r.errors.join(' ') }, { status: 400 })
      }
      case 'parse': {
        const p = parseSheet(String(body.text ?? ''))
        return p.ok ? NextResponse.json(p.sheet) : NextResponse.json({ error: p.error }, { status: 400 })
      }
      case 'preview':
      case 'import': {
        const text = parseSheet(String(body.text ?? ''))
        if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 })
        const valid = new Set<string>(IMPORT_FIELDS.map((f) => f.key))
        const raw = Array.isArray(body.mapping) ? body.mapping : text.sheet.guess
        const mapping = text.sheet.headers.map((_, i) => (typeof raw[i] === 'string' && valid.has(raw[i] as string) ? (raw[i] as ImportFieldKey) : ''))
        if (body.action === 'preview') return NextResponse.json({ rows: await previewImport(text.sheet, mapping) })
        return NextResponse.json(await runImport(text.sheet, mapping))
      }
      case 'link': {
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
        const r = await createProfileLink(id, body.days)
        return r.ok ? NextResponse.json({ token: r.token, path: r.path, expires_at: r.expires_at }) : NextResponse.json({ error: r.error }, { status: 500 })
      }
      case 'links':
        return id ? NextResponse.json({ links: await listProfileLinks(id) }) : NextResponse.json({ error: 'Missing id' }, { status: 400 })
      case 'revoke': {
        if (!id || typeof body.linkId !== 'string') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
        const e = await revokeProfileLink(id, body.linkId)
        return e ? NextResponse.json({ error: e }, { status: 500 }) : NextResponse.json({ ok: true })
      }
      case 'submission': {
        if (!id || !['approve', 'reject'].includes(String(body.decision))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
        const e = await decideSubmission(id, body.decision as 'approve' | 'reject')
        return e ? NextResponse.json({ error: e }, { status: 400 }) : NextResponse.json({ ok: true })
      }
      case 'polish': {
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
        const r = await polishAgentBio(id, String(body.text ?? ''))
        return r.ok ? NextResponse.json({ text: r.text, cached: r.cached }) : NextResponse.json({ error: r.error }, { status: 400 })
      }
      case 'achievement': {
        const r = await saveAchievement((body.achievement ?? {}) as Record<string, unknown>)
        return r.ok ? NextResponse.json({ achievement: r.row }) : NextResponse.json({ error: r.errors.join(' ') }, { status: 400 })
      }
      case 'achievement-delete': {
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
        const e = await deleteAchievement(id)
        return e ? NextResponse.json({ error: e }, { status: 500 }) : NextResponse.json({ ok: true })
      }
      case 'aotm': {
        const r = await setAgentOfMonth((body.aotm ?? {}) as Record<string, unknown>)
        return r.ok ? NextResponse.json({ ok: true, queued: r.queued }) : NextResponse.json({ error: r.errors.join(' ') }, { status: 400 })
      }
      case 'draft': {
        if (!id || !['approve', 'reject'].includes(String(body.decision))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
        const e = await decideDraft(id, body.decision as 'approve' | 'reject')
        return e ? NextResponse.json({ error: e }, { status: 400 }) : NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e) {
    return fail(e)
  }
}
