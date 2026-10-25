// Offline check for flywheel step WP7 (lib/flywheel/steps/network-recover.ts): ends a network pause early and requeues failed sign-in posts
// once the provider reports the account healthy. In-memory fake database and fake provider only: no network, no real database.
// Run: pnpm dlx tsx scripts/check-network-recover.ts   (exits 1 on any failed expectation)
import type { SupabaseClient } from '@supabase/supabase-js'
import { DECISIONS_KEY, POLICY_CAPS, decision, parseDecisions, policyKey, type AutoDecision } from '../lib/auto-decisions'
import { AUTOMATION_PAUSED_KEY } from '../lib/automation-kill-switch'
import { runFlywheelSteps, undoFlywheel } from '../lib/flywheel/registry'
import { NETWORK_PAUSES_KEY, parsePauses } from '../lib/network-pause'
import { NETWORK_RECOVER_STATE_KEY, authFailedRows, createNetworkRecoverStep, ghlHealth, healthOf, networksNamedIn, uploadPostHealth, type Health, type NetworkProbe } from '../lib/flywheel/steps/network-recover'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

interface Row {
  slug: string
  stage: string
  last_error: string | null
  sent_platforms: string[] | null
  updated_at: string
}

/** Fake of app_settings (select by key, upsert) and post_distribution (filtered select). */
function fake(seed: Record<string, string>, rows: Row[]): { admin: SupabaseClient; store: Map<string, string>; rows: Row[] } {
  const store = new Map<string, string>(Object.entries(seed))
  const admin = {
    from(table: string) {
      if (table === 'app_settings') {
        return {
          select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }) }) }),
          upsert: async (row: { key: string; value: string }) => {
            store.set(row.key, row.value)
            return { error: null }
          },
        }
      }
      if (table === 'post_distribution') {
        const q: { stage?: string; gte?: string } = {}
        const chain = {
          eq: (c: string, v: string) => {
            if (c === 'stage') q.stage = v
            return chain
          },
          gte: (_c: string, v: string) => {
            q.gte = v
            return chain
          },
          order: () => chain,
          limit: () => chain,
          then: (res: (v: unknown) => unknown) => res({ data: rows.filter((r) => (!q.stage || r.stage === q.stage) && (!q.gte || r.updated_at >= q.gte)), error: null }),
        }
        return { select: () => chain }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as unknown as SupabaseClient
  return { admin, store, rows }
}

const NOW = new Date('2026-10-24T15:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const H = 3_600_000
const pauseJson = (net: string, sinceAgo: number, untilAhead: number, strikes = 1) => JSON.stringify({ [net]: { since: iso(sinceAgo), until: new Date(NOW.getTime() + untilAhead).toISOString(), strikes } })
const row = (slug: string, err: string, ageMs = 2 * H, over: Partial<Row> = {}): Row => ({ slug, stage: 'failed', last_error: err, sent_platforms: [], updated_at: iso(ageMs), ...over })

const probeWith = (health: Record<string, Health>, calls: { n: number }): NetworkProbe => async () => {
  calls.n++
  return { health }
}

function makeDeps(health: Record<string, Health>, db: { rows: Row[] }, mode = 'auto') {
  const calls = { n: 0 }
  const requeued: string[] = []
  return {
    calls,
    requeued,
    deps: {
      probe: probeWith(health, calls),
      getMode: async () => mode,
      retryPost: async (_a: SupabaseClient, slug: string) => {
        const r = db.rows.find((x) => x.slug === slug)
        if (!r) return 'gone'
        r.stage = 'queued'
        requeued.push(slug)
        return null
      },
    },
  }
}

const input = (admin: SupabaseClient, over: Record<string, unknown> = {}) => ({ admin, startedAt: 0, budgetMs: 200_000, now: NOW, clock: () => 1_000, ...over })
const decisionsOf = (store: Map<string, string>): AutoDecision[] => parseDecisions(store.get(DECISIONS_KEY) ?? null)
const todays = (store: Map<string, string>) => decisionsOf(store).filter((d) => d.policy === 'network_recover')

async function main(): Promise<void> {
  // ---- pure helpers --------------------------------------------------------------------------------------------------
  check('networksNamedIn reads "instagram: 401"', networksNamedIn('instagram: 401 token expired; x: failed').join() === 'instagram,x')
  check('networksNamedIn ignores a word that is not followed by a colon', networksNamedIn('the instagram token is bad').length === 0)
  check('healthOf treats x and twitter as one network', healthOf({ twitter: 'healthy' }, 'x') === 'healthy' && healthOf({ x: 'unhealthy', twitter: 'healthy' }, 'x') === 'unhealthy' && healthOf({}, 'x') === 'unknown')
  check('ghlHealth: expired or inactive is unhealthy, only ticked accounts count', ghlHealth([{ id: 'a', platform: 'instagram', name: 'a', active: true, expired: false }, { id: 'b', platform: 'facebook', name: 'b', active: true, expired: true }, { id: 'c', platform: 'tiktok', name: 'c', active: true, expired: true }], ['a', 'b']).instagram === 'healthy' && ghlHealth([{ id: 'b', platform: 'facebook', name: 'b', active: true, expired: true }], ['b']).facebook === 'unhealthy' && ghlHealth([{ id: 'c', platform: 'tiktok', name: 'c', active: true, expired: false }], ['a']).tiktok === undefined)
  check('uploadPostHealth: needs reconnect is unhealthy, connected is healthy, odd text is unknown', (() => {
    const h = uploadPostHealth([{ username: 'u', accounts: [{ platform: 'Instagram', status: 'connected' }, { platform: 'tiktok', status: 'needs reconnect' }, { platform: 'x', status: 'pending' }] }], 'u')
    return h.instagram === 'healthy' && h.tiktok === 'unhealthy' && h.x === 'unknown'
  })())
  check('authFailedRows keeps only old-enough, never-sent, sign-in failures', authFailedRows([row('a', 'instagram: 401 unauthorized'), row('b', 'instagram: image too large'), row('c', 'instagram: 401', 2 * H, { sent_platforms: ['facebook'] }), row('d', 'instagram: 401', 60_000), row('e', 'instagram: 401', 5 * 86_400_000)], NOW).map((r) => r.slug).join() === 'a')

  // ---- happy path: paused network, account healthy -> pause ended, one post requeued, logged with undo ---------------
  {
    const rows = [row('p1', 'instagram: 401 token expired'), row('p2', 'instagram: reconnect your account', 3 * H), row('p3', 'instagram: 403 forbidden', 4 * H)]
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H, 1) }, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows })
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    const o = r.outcomes[0]
    const pause = parsePauses(store.get(NETWORK_PAUSES_KEY)).instagram
    check('happy path: the step ran', o.status === 'ran', JSON.stringify(o))
    check('happy path: the pause is ended now and the strike is kept', !!pause && Date.parse(pause.until) <= NOW.getTime() && pause.strikes === 1)
    check('happy path: the probe was called exactly once', d.calls.n === 1)
    check('happy path: the cap of 2 allows the un-pause plus exactly one requeue (oldest first)', d.requeued.length === 1 && d.requeued[0] === 'p3', d.requeued.join())
    const log = todays(store)
    check('happy path: two decisions logged, the un-pause with an fw: undo and the requeue with the existing requeue-post undo', log.length === 2 && log.some((x) => x.undo?.kind === 'fw:network_recover') && log.some((x) => x.undo?.kind === 'requeue-post'), JSON.stringify(log.map((x) => x.undo)))
    check('happy path: no personal data in the log', !/@|password|secret/i.test(JSON.stringify(log)))
    check('happy path: state remembers the recovery and the requeued post', (store.get(NETWORK_RECOVER_STATE_KEY) ?? '').includes('instagram'))
    check('happy path: heartbeat written for the step', (store.get('flywheel_last_run:network_recover') ?? '').includes('"ok":true'))

    // Undo of the un-pause restores the original pause and its strike.
    const unpause = log.find((x) => x.undo?.kind === 'fw:network_recover')!
    const u = await undoFlywheel(admin, 'network_recover', unpause.undo!.ref)
    const back = parsePauses(store.get(NETWORK_PAUSES_KEY)).instagram
    check('undo: the original pause is restored with its strike', u.ok && !!back && Date.parse(back.until) > NOW.getTime() - 1 && back.strikes === 1, u.message)
    const u2 = await undoFlywheel(admin, 'network_recover', unpause.undo!.ref)
    check('undo: a second undo changes nothing and says so', u2.ok && /already/.test(u2.message), u2.message)
    const bad = await undoFlywheel(admin, 'network_recover', 'garbage')
    check('undo: a bad ref is refused', bad.ok === false)
  }

  // ---- second pass: cooldown, requeue once only ------------------------------------------------------------------------
  {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H, 1) }, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows })
    await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    // The network pauses again (as the watchdog would after one failure) and the same post fails again.
    store.delete(DECISIONS_KEY) // so the daily cap is not what stops the second pass
    store.set(NETWORK_PAUSES_KEY, pauseJson('instagram', 2 * H, 22 * H, 2))
    rows[0].stage = 'failed'
    const d2 = makeDeps({ instagram: 'healthy' }, { rows })
    const r2 = await runFlywheelSteps(input(admin, { now: new Date(NOW.getTime() + 2 * H) }), [createNetworkRecoverStep(d2.deps)])
    check('loop guard: no second un-pause within 24 hours and the same post is never requeued twice', r2.outcomes[0].status === 'noop' && d2.requeued.length === 0 && d2.calls.n === 0, JSON.stringify(r2.outcomes[0]))
  }

  // ---- unhealthy / unknown account: nothing changes ------------------------------------------------------------------
  for (const h of ['unhealthy', 'unknown'] as const) {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const seed = { [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H) }
    const { admin, store } = fake(seed, rows)
    const d = makeDeps(h === 'unhealthy' ? { instagram: 'unhealthy' } : {}, { rows })
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    check(`${h} account: nothing is un-paused or requeued, nothing logged`, r.outcomes[0].status === 'noop' && store.get(NETWORK_PAUSES_KEY) === seed[NETWORK_PAUSES_KEY] && d.requeued.length === 0 && todays(store).length === 0, JSON.stringify(r.outcomes[0]))
  }

  // ---- a fresh pause is left alone; an error naming an unhealthy second network is left alone ---------------------------
  {
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 10 * 60_000, 23 * H) }, [])
    const d = makeDeps({ instagram: 'healthy' }, { rows: [] })
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    check('a pause under an hour old is not lifted, and the provider is not even asked', r.outcomes[0].status === 'noop' && d.calls.n === 0 && !!parsePauses(store.get(NETWORK_PAUSES_KEY)).instagram)
    const rows = [row('m1', 'instagram: 401 token expired; facebook: 403 forbidden')]
    const fk = fake({}, rows)
    const d2 = makeDeps({ instagram: 'healthy', facebook: 'unhealthy' }, { rows })
    const r2 = await runFlywheelSteps(input(fk.admin), [createNetworkRecoverStep(d2.deps)])
    check('a post whose error also names an unhealthy network is not requeued', r2.outcomes[0].status === 'noop' && d2.requeued.length === 0)
  }

  // ---- not in auto mode: the pause may end, but no post is requeued -------------------------------------------------------
  {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H) }, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows }, 'prepare')
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    check('prepare mode: the pause ends but no post is requeued', r.outcomes[0].status === 'ran' && d.requeued.length === 0 && todays(store).length === 1)
  }

  // ---- the daily cap -----------------------------------------------------------------------------------------------------
  {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const prior = Array.from({ length: POLICY_CAPS.network_recover }, (_v, i) => decision('network_recover', `old${i}`, 'x', 'y', null, new Date(NOW.getTime() - 60_000)))
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H), [DECISIONS_KEY]: JSON.stringify(prior) }, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows })
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    check('cap: nothing happens once the daily limit is used', r.outcomes[0].status === 'skipped' && d.calls.n === 0 && d.requeued.length === 0 && todays(store).length === prior.length, JSON.stringify(r.outcomes[0]))
    // Cap of 2 with one room left: the un-pause uses it and no post is requeued.
    const one = [decision('network_recover', 'old', 'x', 'y', null, new Date(NOW.getTime() - 60_000))]
    const rows2 = [row('p1', 'instagram: 401 token expired')]
    const f2 = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H), [DECISIONS_KEY]: JSON.stringify(one) }, rows2)
    const d2 = makeDeps({ instagram: 'healthy' }, { rows: rows2 })
    const r2 = await runFlywheelSteps(input(f2.admin), [createNetworkRecoverStep(d2.deps)])
    check('cap: with one action left only one thing is done', r2.outcomes[0].acted === 1 && d2.requeued.length === 0 && todays(f2.store).length === 2)
  }

  // ---- kill switches -------------------------------------------------------------------------------------------------------
  for (const [label, key, value] of [['pause-all', AUTOMATION_PAUSED_KEY, 'true'], ['own switch off', policyKey('network_recover'), 'off']] as const) {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const seed = { [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H), [key]: value }
    const { admin, store } = fake(seed, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows })
    const r = await runFlywheelSteps(input(admin), [createNetworkRecoverStep(d.deps)])
    check(`${label}: skipped, nothing touched`, r.outcomes[0].status === 'skipped' && d.calls.n === 0 && store.get(NETWORK_PAUSES_KEY) === seed[NETWORK_PAUSES_KEY] && d.requeued.length === 0, JSON.stringify(r.outcomes[0]))
  }

  // ---- dry run -----------------------------------------------------------------------------------------------------------------
  {
    const rows = [row('p1', 'instagram: 401 token expired')]
    const seed = { [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H) }
    const { admin, store } = fake(seed, rows)
    const d = makeDeps({ instagram: 'healthy' }, { rows })
    const r = await runFlywheelSteps(input(admin, { dryRun: true }), [createNetworkRecoverStep(d.deps)])
    check('dry run (runner): skipped, nothing written', r.outcomes[0].status === 'skipped' && store.get(NETWORK_PAUSES_KEY) === seed[NETWORK_PAUSES_KEY] && d.requeued.length === 0 && d.calls.n === 0)
    const direct = await createNetworkRecoverStep(d.deps).run({ admin, now: NOW, startedAt: 0, budgetMs: 1, dryRun: true, remainingMs: () => 1, room: 2 })
    check('dry run (direct call): the step itself refuses to write', direct.ran === false && store.get(NETWORK_PAUSES_KEY) === seed[NETWORK_PAUSES_KEY] && d.calls.n === 0)
  }

  // ---- error isolation -----------------------------------------------------------------------------------------------------------
  {
    const rows = [row('p1', 'instagram: 401 token expired'), row('p2', 'instagram: 403 forbidden', 3 * H)]
    const { admin, store } = fake({ [NETWORK_PAUSES_KEY]: pauseJson('instagram', 5 * H, 19 * H), [policyKey('network_recover')]: 'on' }, rows)
    const throwing = createNetworkRecoverStep({ probe: async () => { throw new Error('provider exploded') } })
    const ok = createNetworkRecoverStep(makeDeps({ instagram: 'healthy' }, { rows }).deps)
    const other = { id: 'booked_sync', policy: 'booked_sync' as const, label: 'x', order: 20, floorMs: 0, run: async () => ({ ran: true, note: 'other ran' }) }
    const r = await runFlywheelSteps(input(admin), [throwing, other])
    check('error isolation: a throwing provider is reported for this step only and the next step still runs', r.outcomes.find((o) => o.id === 'network_recover')?.status === 'error' && r.outcomes.find((o) => o.id === 'booked_sync')?.status === 'ran', JSON.stringify(r.outcomes))
    check('error isolation: nothing was changed by the failed step', !store.get(NETWORK_RECOVER_STATE_KEY) && todays(store).length === 0)
    // A probe that reports an error (provider down) is a quiet no-op, not a failure and not a recovery.
    const down = createNetworkRecoverStep({ probe: async () => ({ health: {}, error: 'Could not reach GoHighLevel.' }), getMode: async () => 'auto' })
    const r2 = await runFlywheelSteps(input(admin), [down])
    check('provider down: a quiet no-op that names the reason', r2.outcomes[0].status === 'noop' && /reach GoHighLevel/.test(r2.outcomes[0].reason) && todays(store).length === 0)
    // One post failing to requeue does not stop the next one.
    let first = true
    const flaky = createNetworkRecoverStep({ probe: async () => ({ health: { instagram: 'healthy' } }), getMode: async () => 'auto', retryPost: async () => (first ? ((first = false), 'database busy') : null) })
    const f = fake({}, [row('q1', 'instagram: 401 token expired'), row('q2', 'instagram: 403 forbidden', 3 * H)])
    const r3 = await runFlywheelSteps(input(f.admin), [flaky])
    check('error isolation: one post that cannot be requeued does not stop the next', r3.outcomes[0].status === 'ran' && todays(f.store).length === 1 && todays(f.store)[0].subject === 'q1', JSON.stringify(r3.outcomes[0]))
    void ok
  }

  console.log(failed === 0 ? '\n0 failed' : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
