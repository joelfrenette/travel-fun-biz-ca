// Cacheable default copy of /packages/[slug] (English, the site's currency, no cookies). Same page code as @/app/packages/[slug]/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/packages/[slug]/page'
import { runStatic } from '@/lib/static-render'
import { generateMetadata as realGenerateMetadata } from '@/app/packages/[slug]/page'

export const revalidate = 300
// generateMetadata runs outside the page render's async context, so it must enter runStatic() itself. Without this its database reads
// (the recap bundle of a past trip) go out no-store, and Next throws "Page changed from static to dynamic at runtime" (HTTP 500).
export function generateMetadata(props: Parameters<typeof realGenerateMetadata>[0]) {
  return runStatic(() => realGenerateMetadata(props))
}
// No pages are built ahead of time: each one is built on its first request, then cached (on-demand ISR).
export function generateStaticParams() {
  return []
}

export default function StaticPage(props: Parameters<typeof Page>[0]) {
  return runStatic(() => Page(props))
}
