// PostgREST caps any single response at 1000 rows no matter what .limit() says, so a plain
// select().limit(20000) silently returns the first 1000 rows. This reads a query page by page with
// .range(). A failed page or a hit on the page ceiling is reported, so a caller can show
// "Not tracked" instead of a partial sum that looks complete.

export const PAGE_SIZE = 1000

export interface PagedResult<T> {
  rows: T[]
  /** true when every page was read and the result is complete. */
  ok: boolean
  error?: string
  /** true when the page ceiling stopped the read before the end. */
  capped?: boolean
}

type PageBuilder = (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>

/** `build(from, to)` must return the query with a stable order and `.range(from, to)` applied. */
export async function readAllPages<T>(build: PageBuilder, maxPages = 200): Promise<PagedResult<T>> {
  const rows: T[] = []
  for (let i = 0; i < maxPages; i++) {
    let res: Awaited<ReturnType<PageBuilder>>
    try {
      res = await build(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    } catch (e) {
      return { rows, ok: false, error: e instanceof Error ? e.message : 'read failed' }
    }
    if (res.error) return { rows, ok: false, error: res.error.message }
    const got = (res.data ?? []) as T[]
    rows.push(...got)
    if (got.length < PAGE_SIZE) return { rows, ok: true }
  }
  return { rows, ok: false, capped: true, error: `more than ${maxPages * PAGE_SIZE} rows` }
}
