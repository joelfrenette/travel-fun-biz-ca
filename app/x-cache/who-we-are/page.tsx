// Cacheable default copy of /who-we-are (English, the site's currency, no cookies). Same page code as @/app/who-we-are/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/who-we-are/page'
import { runStatic } from '@/lib/static-render'
export { metadata } from '@/app/who-we-are/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
