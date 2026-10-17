// /llms.txt: a plain-text guide for AI assistants (see lib/llms-txt.ts). Published pages only, cached for an hour.
import { buildLlmsTxt, getLlmsData } from '@/lib/llms-txt'

export const revalidate = 3600

export async function GET() {
  const text = buildLlmsTxt(await getLlmsData())
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } })
}
