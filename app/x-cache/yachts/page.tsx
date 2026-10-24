// Cacheable default copy of /yachts (English, the site's currency, no cookies). Same page code as @/app/yachts/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/yachts/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/yachts/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
