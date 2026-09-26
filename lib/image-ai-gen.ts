// AI-generated art for a package with NO source photo at all and no usable Pexels match — the
// genuine gap-filler case, on top of the smart-crop pipeline (lib/image-pipeline.ts) and Pexels
// (lib/pexels.ts). Joel picked OpenAI's images API for this (2026-09-26) after the provider
// decision was logged rather than guessed. Dormant until OPENAI_API_KEY is set. Real per-image
// cost — this is why nothing calls it automatically; the admin route only fires it on an explicit
// "Generate AI image" action, never as a silent fallback when Pexels comes up empty. Generates one
// landscape image and lets lib/image-pipeline.ts's own smart-crop produce the other 3 formats from
// it, instead of calling OpenAI 4 times for 4 shapes.
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations'
const TIMEOUT_MS = 60_000

export function isImageAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY
}

export interface AiImageResult {
  buffer: Buffer
  model: string
}

/** One AI-generated landscape image for a prompt, or null when unconfigured or the request fails
 * — never throws. Every prompt is wrapped so the model renders it as an illustration, not as a
 * claimed photograph — this fills a gap in real photo coverage, it must never be shown as if it
 * were a real photo of the place. `quality: 'medium'` is the one dial here worth knowing about:
 * OpenAI bills per image by quality tier, so this is a deliberate cost/quality middle ground, not
 * an arbitrary default — raise it if Joel wants sharper output at a higher per-image cost. */
export async function generateAiImage(prompt: string): Promise<AiImageResult | null> {
  const key = process.env.OPENAI_API_KEY
  if (!key || !prompt.trim()) return null

  const model = 'gpt-image-1'
  const wrappedPrompt = `A vibrant, appealing travel-marketing illustration (not a photograph) of: ${prompt}. Professional travel-brochure art style, no text, no watermark, no logos.`

  try {
    const res = await fetch(OPENAI_IMAGES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: wrappedPrompt, size: '1536x1024', quality: 'medium', n: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const b64 = body?.data?.[0]?.b64_json
    if (!b64 || typeof b64 !== 'string') return null
    return { buffer: Buffer.from(b64, 'base64'), model }
  } catch {
    return null
  }
}
