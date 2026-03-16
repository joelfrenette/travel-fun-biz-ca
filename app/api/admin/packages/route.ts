import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { getAllPackagesAdmin, createPackage, generateSlug } from '@/lib/packages'
import { supabase } from '@/integrations/supabase/client'

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

async function uploadImageToSupabase(externalUrl: string, slugBase = 'package') {
  try {
    const res = await fetch(externalUrl)
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)

    const contentType = res.headers.get('content-type') || 'image/jpeg'
    let ext = '.jpg'
    if (contentType.includes('png')) ext = '.png'
    else if (contentType.includes('webp')) ext = '.webp'
    else if (contentType.includes('gif')) ext = '.gif'
    else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg'

    const timestamp = Date.now()
    const safeName = (slugBase || 'package').replace(/[^a-z0-9\-]/gi, '_').toLowerCase()
    const filename = `${safeName}-${timestamp}${ext}`
    const filePath = `package-images/${filename}`

    const arrayBuffer = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Upload to Supabase storage bucket 'package-images'
    const { data, error: uploadError } = await supabase.storage
      .from('package-images')
      .upload(filePath, buffer, { contentType })

    if (uploadError) {
      console.error('[packages-api] Supabase upload failed', uploadError)
      return null
    }

    // Make the file public URL
    const { data: urlData } = supabase.storage.from('package-images').getPublicUrl(filePath)
    if (urlData && urlData.publicUrl) {
      return urlData.publicUrl
    }

    return null
  } catch (err) {
    console.error('[packages-api] Image upload failed', err)
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
    
    // Generate slug if not provided
    if (!body.slug && body.name) {
      body.slug = generateSlug(body.name)
    }

    // If an external image_url is provided, try uploading it to Supabase storage and replace with public URL
    if (body.image_url && typeof body.image_url === 'string' && /^https?:\/\//i.test(body.image_url)) {
      const publicUrl = await uploadImageToSupabase(body.image_url, body.slug || body.name || 'package')
      if (publicUrl) {
        body.image_url = publicUrl
      } else {
        // If upload failed, keep original URL so UI still has an image
      }
    }

    const pkg = await createPackage(body)
    
    if (!pkg) {
      return NextResponse.json({ error: 'Failed to create package' }, { status: 500 })
    }

    return NextResponse.json({ package: pkg })
  } catch (error) {
    console.error('Error creating package:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}