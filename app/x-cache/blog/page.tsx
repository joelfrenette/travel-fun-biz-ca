// Cacheable default copy of /blog (English, the site's currency, no cookies). Same page code as @/app/blog/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/blog/page'
import { runStatic } from '@/lib/static-render'
export { metadata } from '@/app/blog/page'

export const revalidate = 300

export default function StaticPage() {
  return runStatic(() => Page())
}
