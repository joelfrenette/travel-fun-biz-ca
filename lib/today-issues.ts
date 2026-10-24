// Turns the Needs attention list (lib/issues.ts) into Today cards. Pure: it only reads the issues it is given, so the
// offline check can feed it fixtures. Issues with no button (an unreachable key, an email problem, a missing setup
// step) are not human decisions, so they stay on Needs attention and in the System check strip instead of becoming cards.

import type { Issue } from '@/lib/issues'
import { AFFILIATE_PARTNER_ISSUE_ID } from '@/lib/plain-steps'
import { DISMISS_ACTIONS, TODAY_KINDS, cardId, type TodayCard, type TodayKindId } from '@/lib/today-cards'
import { plain } from '@/lib/today-state'

const facts = (pairs: [string, string | undefined | null][]) => pairs.filter(([, v]) => !!v).map(([label, value]) => ({ label, value: plain(String(value)) }))

function make(kind: TodayKindId, key: string, title: string, issue: Issue, extra: { sortKey?: number; why?: string; factPairs?: [string, string | undefined | null][] } = {}): TodayCard {
  const def = TODAY_KINDS[kind]
  return {
    id: cardId(kind, key),
    kind,
    title: plain(title),
    why: extra.why ?? def.why,
    facts: facts(extra.factPairs ?? [[def.facts[0] ?? 'Detail', issue.detail], [def.facts[1] ?? 'What to do', issue.fix]]),
    ...(issue.link ? { link: issue.link } : {}),
    sortKey: extra.sortKey ?? 0,
  }
}

export function cardsFromIssues(issues: Issue[]): TodayCard[] {
  const cards: TodayCard[] = []
  issues.forEach((issue, index) => {
    const id = issue.id
    // Posts that failed to go out. The id is post:<slug>.
    if (id.startsWith('post:')) {
      cards.push(make('failed-post', id.slice('post:'.length), issue.title, issue, { sortKey: index }))
      return
    }
    // A carousel or video that failed (only the ones that offer a Retry button).
    const render = /^(carousel|video):(.+)$/.exec(id)
    if (render) {
      if (issue.actions?.some((a) => a.kind.startsWith('retry-'))) cards.push(make('failed-render', `${render[1]}:${render[2]}`, issue.title, issue, { sortKey: index }))
      return
    }
    if (id === 'system:video-paused') {
      cards.push(make('video-paused', 'paused', issue.title, issue))
      return
    }
    // Held guide posts are listed from the distribution ledger (lib/today-queue.ts), not from here.
    if (id.startsWith('guide-caption:')) return
    if (id.startsWith('agent-submission:')) {
      cards.push(make('agent-submission', id.slice('agent-submission:'.length), issue.title.replace(/^An agent sent a trip to approve: /, 'Trip from an agent: '), issue, { sortKey: index, factPairs: [['Sent by', issue.detail.split(' sent it.')[0]], ['What to do', issue.fix]] }))
      return
    }
    if (id.startsWith('source-watch:')) {
      cards.push(make('supplier-change', id.slice('source-watch:'.length), issue.title, issue, { sortKey: index, factPairs: [['What the check saw', issue.detail], ['What to do', issue.fix]] }))
      return
    }
    if (id.startsWith('package:recap:')) {
      cards.push(make('recap-prompt', id.slice('package:recap:'.length), issue.title, issue, { sortKey: index, factPairs: [['Trip', issue.title.replace(/^The /, '').replace(/ trip has no recap yet$/, '')], ['What is missing', issue.detail]] }))
      return
    }
    if (id.startsWith('package:thin:')) {
      cards.push(make('thin-page', id.slice('package:thin:'.length), issue.title, issue, { sortKey: index, factPairs: [['What is missing', issue.detail], ['What to do', issue.fix]] }))
      return
    }
    if (id === AFFILIATE_PARTNER_ISSUE_ID) {
      cards.push(make('affiliate-setup', 'partner', issue.title, issue, { factPairs: [['What is missing', issue.detail], ['What to do', issue.fix]] }))
      return
    }
    // Anything else with a plain Dismiss button becomes a "Clear it" card.
    const dismiss = issue.actions?.find((a) => (DISMISS_ACTIONS as readonly string[]).includes(a.kind))
    if (dismiss) {
      const key = dismiss.slug ? `${dismiss.kind}:${dismiss.slug}` : dismiss.kind
      cards.push(make('issue-dismiss', key, issue.title, issue, { sortKey: index }))
    }
  })
  return cards
}
