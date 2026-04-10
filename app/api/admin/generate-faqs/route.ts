import { NextResponse } from 'next/server'
import { validateToken } from '@/lib/admin-auth'

// Placeholder FAQ generator - generates common Q&A based on package context
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  
  if (!validateToken(token || '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { name, destination, duration, price_display, short_description, highlights, price_includes, not_included } = body

    const faqs = []

    // Q1: What's included
    faqs.push({
      question: `What is included in the ${name || 'package'} price?`,
      answer: price_includes 
        ? `The package price includes: ${price_includes.replace(/\n/g, ', ')}. Please check the full itinerary for complete details.`
        : `The package typically includes accommodation, selected meals, transportation, and guided tours. Please contact us for the complete list of inclusions.`
    })

    // Q2: What's not included
    faqs.push({
      question: 'What is NOT included in the package?',
      answer: not_included
        ? `The following are not included: ${not_included.replace(/\n/g, ', ')}. These can often be arranged separately upon request.`
        : `Items typically not included are: international flights, travel insurance, personal expenses, tips, and optional activities. Please review the full package details.`
    })

    // Q3: Duration
    if (duration) {
      faqs.push({
        question: 'How long is this trip?',
        answer: `This package is ${duration}. The itinerary is carefully designed to give you the best experience within this timeframe.`
      })
    }

    // Q4: Best time to visit
    if (destination) {
      faqs.push({
        question: `When is the best time to visit ${destination}?`,
        answer: `The best time to visit ${destination} depends on your preferences. We recommend checking local weather patterns and peak seasons. Our travel experts can help you choose the ideal dates for your trip.`
      })
    }

    // Q5: Booking and payment
    faqs.push({
      question: 'How do I book this package?',
      answer: `You can book this package by clicking the "Book Now" button or contacting our travel specialists. A deposit is typically required to secure your booking, with the balance due before departure.`
    })

    // Q6: Cancellation policy
    faqs.push({
      question: 'What is the cancellation policy?',
      answer: `Our cancellation policy varies depending on the package and timing. Generally, cancellations made 30+ days before departure receive a full refund minus administrative fees. Please review the specific terms for this package or contact us for details.`
    })

    // Q7: Group size
    faqs.push({
      question: 'What is the group size for this tour?',
      answer: `Group sizes vary by package. We typically maintain small groups to ensure a personalized experience. Contact us for specific group size information for this package.`
    })

    // Q8: Fitness level
    faqs.push({
      question: 'What fitness level is required?',
      answer: `This package is designed to be accessible to most travelers. Some activities may require moderate fitness. Please review the itinerary and contact us if you have specific concerns about physical requirements.`
    })

    return NextResponse.json({ faqs })
  } catch (err) {
    console.error('[generate-faqs] error', err)
    return NextResponse.json({ error: 'FAQ generation failed' }, { status: 500 })
  }
}
