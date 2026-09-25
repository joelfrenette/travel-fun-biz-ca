import { getSupabaseAdmin } from '@/lib/supabase-admin'
import { supabase } from '@/integrations/supabase/client'

export interface Testimonial {
  id: string
  author: string
  location: string | null
  trip_name: string | null
  package_id: string | null
  rating: number
  text: string
  image_url: string | null
  source: string | null
  status: 'draft' | 'published'
  featured: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/** Published testimonials for the public site (anon client, RLS-filtered). */
export async function getPublishedTestimonials(): Promise<Testimonial[]> {
  const { data, error } = await supabase
    .from('testimonials')
    .select('*')
    .eq('status', 'published')
    .order('sort_order', { ascending: true })
  if (error) {
    console.error('Failed to load testimonials:', error.message)
    return []
  }
  return data || []
}

export async function listTestimonials(): Promise<Testimonial[]> {
  const { data, error } = await getSupabaseAdmin().from('testimonials').select('*').order('sort_order', { ascending: true })
  if (error) throw new Error(error.message)
  return data || []
}

export type TestimonialInput = Partial<Omit<Testimonial, 'id' | 'created_at' | 'updated_at'>>

export async function createTestimonial(input: TestimonialInput): Promise<Testimonial> {
  if (!input.author?.trim()) throw new Error('Author is required')
  if (!input.text?.trim()) throw new Error('Testimonial text is required')
  const { data, error } = await getSupabaseAdmin()
    .from('testimonials')
    .insert({
      author: input.author.trim(),
      location: input.location || null,
      trip_name: input.trip_name || null,
      package_id: input.package_id || null,
      rating: input.rating ?? 5,
      text: input.text.trim(),
      image_url: input.image_url || null,
      source: input.source || null,
      status: input.status === 'draft' ? 'draft' : 'published',
      featured: !!input.featured,
      sort_order: input.sort_order ?? 0,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function updateTestimonial(id: string, patch: TestimonialInput): Promise<Testimonial> {
  const { data, error } = await getSupabaseAdmin()
    .from('testimonials')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteTestimonial(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from('testimonials').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
