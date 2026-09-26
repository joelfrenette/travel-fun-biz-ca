// AI-generated art for a package with NO source photo at all and no usable Pexels match — the
// genuine gap-filler case Joel asked for on top of the smart-crop pipeline (lib/image-pipeline.ts)
// and Pexels (lib/pexels.ts). Deliberately NOT wired to a real provider yet: Anthropic's API does
// not generate images, so this needs its own provider decision (OpenAI's image API, Google
// Imagen, Stability, Ideogram, Replicate — different cost, quality and ToS tradeoffs) the same way
// the social-distribution provider decision was left open rather than guessed. Logged as a
// roadmap use case; app/api/admin/generate-thumbnail already had an unfinished dummyimage.com
// placeholder for this exact gap (its own comment says "replace with a real AI image generation
// API when available") — this file is the real, honest version of that: off until configured,
// never a fake placeholder image passed off as generated art.
export function isImageAiConfigured(): boolean {
  return false
}

/** Always null until a provider is chosen and its key is wired in here. Never throws, never
 * fabricates a placeholder image and returns it as if it were real generated art. */
export async function generateAiImage(_prompt: string): Promise<{ url: string } | null> {
  return null
}
