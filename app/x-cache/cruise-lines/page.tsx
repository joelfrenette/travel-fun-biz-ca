// Cacheable default copy of /cruise-lines (English, the site's currency, no cookies). Same page code as @/app/cruise-lines/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/cruise-lines/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/cruise-lines/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
