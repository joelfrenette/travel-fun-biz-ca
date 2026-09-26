// Ported from Nomad Escape Plan's lib/safe-markdown.ts (Factory Phase 1: foundation) — just the
// JSON-LD half; the markdown-sanitizing half is folded into lib/markdown.ts's own hardening
// instead of a second renderer (see that file's comment).
/**
 * Structured data for a <script type="application/ld+json">. JSON.stringify leaves `<` alone, so
 * a title or description containing the literal text `</script>` would close the tag early and
 * whatever follows would run as plain HTML — the exact bug this session already found and fixed
 * once in a published artifact. `<` reads the same to a JSON parser once escaped, so this is a
 * free, invisible fix: every existing caller can switch to it verbatim.
 */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}
