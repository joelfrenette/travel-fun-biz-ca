import { NextResponse } from 'next/server'
import { isAuthorized } from '@/lib/admin-auth'

// Closed (410). This route used to spend DataForSEO credit on demand, outside the weekly keyword budget and
// the spend log. Keyword ideas now come only from the weekly keyword engine, whose button respects the budget.
const GONE = { error: 'Keyword ideas now come from the weekly engine (Run the engine now on the Keyword Research page)' }

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(GONE, { status: 410 })
}

export async function PATCH(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(GONE, { status: 410 })
}
