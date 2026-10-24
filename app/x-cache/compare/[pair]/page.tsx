// Cacheable default copy of /compare/[pair] (English, the site's currency, no cookies). Same page code as @/app/compare/[pair]/page, run through runStatic().
// Reached only by middleware.ts for visitors with no language / currency choice; the address people see is the real one. See lib/cache-routing.ts.
import Page from '@/app/compare/[pair]/page'
import { runStatic } from '@/lib/static-render'
export { generateMetadata } from '@/app/compare/[pair]/page'

export const revalidate = 300
// No pages are built ahead of time: each one is built on its first request, then cached (on-demand ISR).
export function generateStaticParams() {
  return []
}

export default function StaticPage(props: Parameters<typeof Page>[0]) {
  return runStatic(() => Page(props))
}
