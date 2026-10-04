import { getPublishedPosts } from '@/lib/posts'
import { supabase } from '@/integrations/supabase/client'

// Post-publish drift monitoring (factory spec, Nomad Escape Plan item 1): a post is only grounded
// in facts on the day it's written - the underlying travel_packages row can change after (a price
// updates, a trip sells out and gets unpublished, its dates pass). This re-reads every PUBLISHED
// post and checks it against CURRENT package data, the same no-invented-data discipline as
// composition itself, just applied after the fact instead of before.
//
// Deliberately deterministic, not AI-based: every finding here is a real database fact mismatch
// (a package no longer published, a trip's dates already passed, a dead link), not a guess about
// whether free-text prose "still sounds right." Scanning prose for invented numeric drift is a
// real future enhancement, not attempted here - a false positive on that would be worse than a
// missed one, and it needs its own careful design.

export interface DriftFinding {
  postId: string
  postSlug: string
  postTitle: string
  kind: 'related_package_unpublished' | 'related_package_dates_passed' | 'linked_package_unpublished'
  detail: string
}

interface PackageRow {
  id: string
  slug: string
  status: string
  available_to: string | null
}

/** Every /packages/<slug> link inside a post body, deduped. Catches a stale reference even when
 * it's just in the prose (e.g. autoblog's own CTA link, lib/autoblog-run.ts's appendCta) and not
 * the post's related_package_id. */
function extractLinkedPackageSlugs(body: string): string[] {
  const slugs = new Set<string>()
  const re = /\/packages\/([a-z0-9-]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) slugs.add(match[1])
  return Array.from(slugs)
}

export async function checkPublishedPostsForDrift(): Promise<DriftFinding[]> {
  const [posts, packagesRes] = await Promise.all([
    getPublishedPosts(),
    supabase.from('travel_packages').select('id, slug, status, available_to'),
  ])
  if (packagesRes.error) throw new Error(packagesRes.error.message)
  const packages = (packagesRes.data ?? []) as PackageRow[]
  const byId = new Map(packages.map((p) => [p.id, p]))
  const bySlug = new Map(packages.map((p) => [p.slug, p]))
  const today = new Date().toISOString().slice(0, 10)

  const findings: DriftFinding[] = []

  for (const post of posts) {
    if (post.related_package_id) {
      const pkg = byId.get(post.related_package_id)
      if (!pkg || pkg.status !== 'published') {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'related_package_unpublished',
          detail: pkg ? `Related package is now "${pkg.status}", not published.` : 'Related package no longer exists.',
        })
      } else if (pkg.available_to && pkg.available_to < today) {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'related_package_dates_passed',
          detail: `Related package's dates (ended ${pkg.available_to}) have already passed.`,
        })
      }
    }

    for (const slug of extractLinkedPackageSlugs(post.body)) {
      if (post.related_package_id && byId.get(post.related_package_id)?.slug === slug) continue // already checked above
      const pkg = bySlug.get(slug)
      if (!pkg || pkg.status !== 'published') {
        findings.push({
          postId: post.id,
          postSlug: post.slug,
          postTitle: post.title,
          kind: 'linked_package_unpublished',
          detail: `Links to /packages/${slug}, which is ${pkg ? `now "${pkg.status}"` : 'gone'}.`,
        })
      }
    }
  }

  return findings
}
