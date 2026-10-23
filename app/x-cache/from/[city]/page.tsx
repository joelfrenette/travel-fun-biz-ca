// Cacheable default copy of /from/[city] (English, the site's currency, no cookies). Same page code as @/app/from/[city]/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/from/[city]/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/from/[city]/page'
export { generateStaticParams } from '@/app/from/[city]/page'

export const revalidate = 300
export const dynamicParams = false

export default function StaticPage(props: Parameters<typeof Page>[0]) {
  return runStatic(() => Page(props))
}
