import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'

// Placeholder AI field generator - generates content based on package context
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { field, name, destination, duration, price_display, short_description, highlights, categories } = body

    let value = ''

    switch (field) {
      case 'keywords':
        // Generate SEO keywords based on package info
        const keywordParts = []
        if (destination) keywordParts.push(destination.toLowerCase(), `${destination.toLowerCase()} vacation`, `${destination.toLowerCase()} travel`)
        if (name) {
          const words = name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3 && !['with', 'the', 'and', 'for'].includes(w))
          keywordParts.push(...words.slice(0, 3))
        }
        if (categories && categories.length > 0) {
          keywordParts.push(...categories.map((c: string) => c.toLowerCase()))
        }
        keywordParts.push('travel package', 'vacation deal', 'holiday')
        value = [...new Set(keywordParts)].slice(0, 10).join(', ')
        break

      case 'short_description':
        // Generate a short marketing description
        value = `Experience an unforgettable ${duration || 'getaway'} to ${destination || 'an amazing destination'}. `
        if (name) value += `${name} offers the perfect blend of adventure and relaxation. `
        if (price_display) value += `Starting from ${price_display}.`
        break

      case 'full_description':
        // Generate a longer description
        value = `Discover the magic of ${destination || 'your dream destination'} with our exclusive ${name || 'travel package'}.\n\n`
        value += `This ${duration || 'incredible journey'} takes you through breathtaking landscapes and unforgettable experiences. `
        value += `Whether you're seeking adventure, relaxation, or cultural immersion, this package has something for everyone.\n\n`
        if (highlights) {
          const highlightList = typeof highlights === 'string' ? highlights.split('\n') : highlights
          if (highlightList.length > 0) {
            value += `Highlights include: ${highlightList.slice(0, 3).join(', ')}.\n\n`
          }
        }
        value += `Book now and create memories that will last a lifetime!`
        break

      case 'highlights':
        // Generate highlights based on destination and category
        const highlightItems = []
        if (destination) {
          highlightItems.push(`Explore the best of ${destination}`)
          highlightItems.push(`Local guided tours and experiences`)
        }
        if (categories?.includes('Beach & Resort')) {
          highlightItems.push('Pristine beaches and crystal-clear waters')
          highlightItems.push('Beachfront accommodation')
        }
        if (categories?.includes('Adventure')) {
          highlightItems.push('Thrilling outdoor activities')
          highlightItems.push('Expert adventure guides')
        }
        if (categories?.includes('Cultural')) {
          highlightItems.push('Immersive cultural experiences')
          highlightItems.push('Historic site visits')
        }
        highlightItems.push('Professional tour coordination')
        highlightItems.push('24/7 customer support')
        value = highlightItems.slice(0, 6).join('\n')
        break

      case 'price_includes':
        // Generate what's included
        const includes = [
          'Accommodation as per itinerary',
          'Daily breakfast',
          'Airport transfers',
          'Professional tour guide',
          'All entrance fees to attractions',
          'Transportation during the tour',
        ]
        if (categories?.includes('Cruise')) {
          includes.unshift('Cruise cabin accommodation')
          includes.push('All meals onboard')
          includes.push('Onboard entertainment')
        }
        value = includes.join('\n')
        break

      case 'not_included':
        // Generate what's not included
        const notIncluded = [
          'International flights (unless specified)',
          'Travel insurance',
          'Personal expenses',
          'Tips and gratuities',
          'Optional activities',
          'Visa fees (if applicable)',
          'Meals not mentioned in the itinerary',
        ]
        value = notIncluded.join('\n')
        break

      default:
        return NextResponse.json({ error: 'Unknown field' }, { status: 400 })
    }

    return NextResponse.json({ value })
  } catch (err) {
    console.error('[generate-field] error', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
