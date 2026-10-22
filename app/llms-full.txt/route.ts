// /llms-full.txt: fuller plain-text guide summaries for AI assistants (see lib/llms-full.ts). Published, non-thin guides only,
// no prices, cached for an hour like /llms.txt.
import { buildLlmsFull, getLlmsFullRows } from '@/lib/llms-full'

export const revalidate = 3600

export async function GET() {
  const text = buildLlmsFull(await getLlmsFullRows())
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } })
}
