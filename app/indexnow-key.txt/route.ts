// IndexNow key file: search engines fetch this to prove we own the host (see lib/indexnow.ts).
import { isIndexNowConfigured } from '@/lib/indexnow'

export const dynamic = 'force-dynamic'

export function GET() {
  if (!isIndexNowConfigured()) return new Response('Not found', { status: 404 })
  return new Response(process.env.INDEXNOW_KEY, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } })
}
