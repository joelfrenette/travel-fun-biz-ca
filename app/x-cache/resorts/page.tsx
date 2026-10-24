// Cacheable default copy of /resorts (English, the site's currency, no cookies). Same page code as @/app/resorts/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/resorts/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/resorts/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
