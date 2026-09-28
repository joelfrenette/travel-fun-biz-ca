import { excerptFromMarkdown } from '@/lib/markdown'
import { SITE_NAME, absoluteUrl } from '@/lib/site'

// Only the fields the kit actually needs, so it works from either a saved Post or the admin
// editor's in-progress PostInput form state without fighting PostInput's optionality.
export interface SyndicatablePost {
  title: string
  slug: string
  body: string
  tags: string[]
  meta_description?: string | null
}

// Syndication kit (roadmap use case 93f89574, from Nomad factory-v9 PARITY-SPEC §16 item 20):
// "teaser to LinkedIn, full text to Substack, import to Medium" for a published post. Nothing
// posts automatically here - each platform still has its own manual step (LinkedIn's own
// composer, Substack's paste-and-import, Medium's paste-and-import). This module only repackages
// a post's own real, already-published content into the shape each platform expects - no AI
// call, nothing invented, so there is no fabrication risk to review: whatever the post already
// says is all that goes out.

function fullBodyWithFootnote(post: SyndicatablePost, url: string): string {
  const note = `---\n\n*Originally published on the [${SITE_NAME}](${url}) blog.*`
  return `${post.body.trim()}\n\n${note}`
}

export interface SyndicationKit {
  postUrl: string
  linkedin: string
  substack: string
  medium: string
}

/** Everything is deterministic and derived only from the post's own already-published fields -
 * safe to compute for any published post with no review gate needed beyond "is this post itself
 * accurate", which publishing it already required. */
export function buildSyndicationKit(post: SyndicatablePost): SyndicationKit {
  const url = absoluteUrl(`/blog/${post.slug}`)
  const excerpt = post.meta_description?.trim() || excerptFromMarkdown(post.body, 220)
  const hashtags = post.tags.slice(0, 3).map((t) => `#${t.replace(/[^a-z0-9]+/gi, '')}`).filter((t) => t.length > 1).join(' ')

  const linkedin = [
    post.title,
    '',
    excerpt,
    '',
    `Read the full post: ${url}`,
    hashtags || null,
  ].filter((line) => line !== null).join('\n')

  return {
    postUrl: url,
    linkedin,
    // Substack's paste-and-import reads Markdown reasonably well; keep the post's own formatting.
    substack: `# ${post.title}\n\n${fullBodyWithFootnote(post, url)}`,
    // Medium's importer wants the ORIGINAL url in its own "Import a story" canonical field, not
    // repeated in the pasted body, so the body itself stays plain - the reminder goes beside the
    // Copy button in the UI instead of inside this text.
    medium: `${post.title}\n\n${post.body.trim()}`,
  }
}
