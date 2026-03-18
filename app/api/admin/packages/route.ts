import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { getAllPackagesAdmin, createPackage, generateSlug } from '@/lib/packages'
import { createClient } from '@supabase/supabase-js'

// Create a Supabase client with service role for server-side operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ldwmbwsxrktpcisqaxrb.supabase.co'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// GET all packages (admin)
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const packages = await getAllPackagesAdmin()
  return NextResponse.json({ packages })
}

async function uploadImageToSupabase(externalUrl: string, slugBase = 'package'): Promise<string | null> {
  console.log('[packages-api] Starting image upload for:', externalUrl)
  
  // Check if we have the service role key
  if (!supabaseServiceKey) {
    console.log('[packages-api] No SUPABASE_SERVICE_ROLE_KEY configured, skipping upload')
    return null
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  })

  try {
    console.log('[packages-api] Fetching external image...')
    const res = await fetch(externalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    
    if (!res.ok) {
      console.error('[packages-api] Failed to fetch image:', res.status, res.statusText)
      return null
    }

    const contentType = res.headers.get('content-type') || 'image/jpeg'
    console.log('[packages-api] Image content-type:', contentType)
    
    let ext = '.jpg'
    if (contentType.includes('png')) ext = '.png'
    else if (contentType.includes('webp')) ext = '.webp'
    else if (contentType.includes('gif')) ext = '.gif'
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg'

    const timestamp = Date.now()
    const safeName = (slugBase || 'package').replace(/[^a-z0-9\-]/gi, '_').toLowerCase()
    const filename = `${safeName}-${timestamp}${ext}`

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    console.log('[packages-api] Image size:', buffer.length, 'bytes')

    // Upload to Supabase storage bucket 'package-images'
    console.log('[packages-api] Uploading to Supabase storage...')
    const { data, error: uploadError } = await supabaseAdmin.storage
      .from('package-images')
      .upload(filename, buffer, { 
        contentType,
        upsert: true 
      })

    if (uploadError) {
      console.error('[packages-api] Supabase upload failed:', uploadError.message, uploadError)
      return null
    }

    console.log('[packages-api] Upload successful:', data)

    // Get the public URL
    const { data: urlData } = supabaseAdmin.storage.from('package-images').getPublicUrl(filename)
    if (urlData && urlData.publicUrl) {
      console.log('[packages-api] Public URL:', urlData.publicUrl)
      return urlData.publicUrl
    }

    return null
  } catch (err) {
    console.error('[packages-api] Image upload error:', err)
    return null
  }
}

// POST create new package
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    console.log('[packages-api] Creating package:', body.name)
    
    // Generate slug if not provided
    if (!body.slug && body.name) {
      body.slug = generateSlug(body.name)
    }

    // If an external image_url is provided, try uploading it to Supabase storage
    if (body.image_url && typeof body.image_url === 'string' && /^https?:\/\//i.test(body.image_url)) {
      console.log('[packages-api] External image detected, attempting upload...')
      const publicUrl = await uploadImageToSupabase(body.image_url, body.slug || body.name || 'package')
      if (publicUrl) {
        console.log('[packages-api] Image uploaded successfully, using new URL')
        body.image_url = publicUrl
      } else {
        console.log('[packages-api] Image upload failed, keeping original URL')
        // Keep original URL so UI still has an image
      }
    }

    const pkg = await createPackage(body)
    
    if (!pkg) {
      return NextResponse.json({ error: 'Failed to create package' }, { status: 500 })
    }

    console.log('[packages-api] Package created successfully:', pkg.id)
    return NextResponse.json({ package: pkg })
  } catch (error) {
    console.error('[packages-api] Error creating package:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
