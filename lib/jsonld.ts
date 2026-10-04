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

/** A schema.org CollectionPage + ItemList of package links - the same shape
 * app/best-time-to-visit/[destination]/page.tsx and app/compare/[pair]/page.tsx each hand-built
 * independently, already drifting in wording before this shared version existed. */
export function buildCollectionPageJsonLd(
  name: string,
  description: string,
  url: string,
  packages: { slug: string; name: string }[],
  absoluteUrl: (path: string) => string,
) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name,
      description,
      url,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: packages.map((pkg, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: absoluteUrl(`/packages/${pkg.slug}`),
          name: pkg.name,
        })),
      },
    },
  ]
}
