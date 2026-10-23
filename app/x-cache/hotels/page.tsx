// Cacheable default copy of /hotels (English, the site's currency, no cookies). Same page code as @/app/hotels/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/hotels/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/hotels/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
