// Cacheable default copy of /yachts (English, the site's currency, no cookies). Same page code as @/app/yachts/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/yachts/page'
import { runStatic } from '@/lib/static-render'
import { generateMetadata as realGenerateMetadata } from '@/app/yachts/page'
// generateMetadata runs outside the page render's async context, so it must enter runStatic() itself (see app/x-cache/packages/[slug]).
export function generateMetadata(...args: Parameters<typeof realGenerateMetadata>) {
  return runStatic(() => realGenerateMetadata(...args))
}

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
