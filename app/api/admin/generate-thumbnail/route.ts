import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'
import { supabase } from '@/integrations/supabase/client'

// Simple AI thumbnail generator endpoint (placeholder implementation)
// This endpoint should call an image generation API (OpenAI, Stability, etc.).
// For now it will generate a placeholder image using a lightweight text-to-image
// service: https://dummyimage.com (or you can plug your preferred service).

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { name, destination, short_description, highlights } = body

    // Build a prompt for the AI (simple text composition)
    const promptParts = []
    if (name) promptParts.push(name)
    if (destination) promptParts.push(destination)
    if (short_description) promptParts.push(short_description)
    if (Array.isArray(highlights) && highlights.length > 0) promptParts.push(highlights.slice(0,3).join(' | '))

    const prompt = promptParts.join(' — ')

    // For now use dummyimage.com to create a placeholder image with the prompt text
    // Replace this with a real AI image generation API when available.
    const encoded = encodeURIComponent(prompt.substring(0, 100))
    const imageUrl = `https://dummyimage.com/800x450/1c1c1c/ffffff&text=${encoded}`

    // Optionally upload generated image to Supabase storage like we do for imports
    try {
      const res = await fetch(imageUrl)
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const timestamp = Date.now()
        const safeName = (name || 'ai-thumb').replace(/[^a-z0-9\-]/gi, '_').toLowerCase()
        const filename = `${safeName}-${timestamp}.jpg`

        const { error: uploadError } = await supabase.storage
          .from('package-images')
          .upload(filename, buffer, { contentType: 'image/jpeg' })

        if (!uploadError) {
          const { data: urlData } = supabase.storage.from('package-images').getPublicUrl(filename)
          if (urlData && urlData.publicUrl) {
            return NextResponse.json({ url: urlData.publicUrl })
          }
        }
      }
    } catch (err) {
      console.error('[generate-thumbnail] upload failed', err)
    }

    return NextResponse.json({ url: imageUrl })
  } catch (err) {
    console.error('[generate-thumbnail] error', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
