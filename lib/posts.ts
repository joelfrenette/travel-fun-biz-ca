// Blog & Content Core (E7) groundwork: the posts table's data-access layer only.
// NOT built yet: an admin editor and the public /blog pages - see roadmap #703 and #705.
import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { supabase } from '@/integrations/supabase/client'

export interface Post {
  id: string
  title: string
  slug: string
  body: string
  cover_image_url: string | null
  tags: string[]
  related_package_id: string | null
  status: 'draft' | 'published'
  publish_date: string | null
  meta_title: string | null
  meta_description: string | null
  created_at: string
  updated_at: string
}

/** Published posts for the public site (anon client, RLS-filtered: published and not future-dated). */
export async function getPublishedPosts(): Promise<Post[]> {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('status', 'published')
    .order('publish_date', { ascending: false, nullsFirst: false })
  if (error) {
    console.error('Failed to load posts:', error.message)
    return []
  }
  return data || []
}

export async function getPublishedPostBySlug(slug: string): Promise<Post | null> {
  const { data, error } = await supabase.from('posts').select('*').eq('slug', slug).eq('status', 'published').maybeSingle()
  if (error) {
    console.error('Failed to load post by slug:', error.message)
    return null
  }
  return data
}

export async function listPostsAdmin(): Promise<Post[]> {
  const { data, error } = await getSupabaseAdmin().from('posts').select('*').order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

export type PostInput = Partial<Omit<Post, 'id' | 'created_at' | 'updated_at'>>

export async function createPost(input: PostInput): Promise<Post> {
  if (!input.title?.trim()) throw new Error('Title is required')
  if (!input.slug?.trim()) throw new Error('Slug is required')
  const { data, error } = await getSupabaseAdmin()
    .from('posts')
    .insert({
      title: input.title.trim(),
      slug: input.slug.trim(),
      body: input.body ?? '',
      cover_image_url: input.cover_image_url || null,
      tags: input.tags ?? [],
      related_package_id: input.related_package_id || null,
      status: input.status === 'published' ? 'published' : 'draft',
      publish_date: input.publish_date || null,
      meta_title: input.meta_title || null,
      meta_description: input.meta_description || null,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function updatePost(id: string, patch: PostInput): Promise<Post> {
  const { data, error } = await getSupabaseAdmin()
    .from('posts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deletePost(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from('posts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
