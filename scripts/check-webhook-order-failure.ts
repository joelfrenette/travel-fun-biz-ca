// Offline check: a failed order write must not be swallowed by the GoHighLevel webhook.
// Run: pnpm dlx tsx scripts/check-webhook-order-failure.ts   (exit 1 on a failure)
import { handleOrderWrite, orderWebhookFailureCount, safeOrderError } from '../lib/webhook-order-result'
import { ORDER_WEBHOOK_ISSUE_ID, plainAction } from '../lib/plain-steps'

let failures = 0
function expect(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

const PII = 'jane.doe@example.org'
const PHONE = '+1 (555) 123-4567'
const pii = (t: string) => t.includes(PII) || t.includes('jane') || t.includes('555') || t.includes('4567')

async function main() {
  // 1. recordOrder returns {error}: 500, event marked failed, no personal data
  {
    const marks: string[] = []
    const out = await handleOrderWrite(
      async () => ({ error: `duplicate key value violates constraint; Key (email)=(${PII}) phone ${PHONE} already exists` }),
      async (t) => void marks.push(t),
    )
    expect('returned error -> status 500', out.status === 500)
    expect('returned error -> event marked failed once', marks.length === 1)
    expect('returned error -> no personal data in text', !pii(marks[0] ?? '') && !pii(out.errorText ?? ''), marks[0])
    expect('error text is short', (marks[0] ?? '').length > 0 && (marks[0] ?? '').length <= 120)
  }
  // 2. thrown error: same
  {
    const marks: string[] = []
    const out = await handleOrderWrite(
      async () => {
        throw new Error(`connection failed for ${PII}`)
      },
      async (t) => void marks.push(t),
    )
    expect('thrown error -> status 500', out.status === 500)
    expect('thrown error -> event marked failed', marks.length === 1)
    expect('thrown error -> no personal data', !pii(marks[0] ?? ''), marks[0])
  }
  // 3. success
  {
    const marks: string[] = []
    const out = await handleOrderWrite(async () => ({}), async (t) => void marks.push(t))
    expect('success -> status 200', out.status === 200)
    expect('success -> nothing marked failed', marks.length === 0)
  }
  // 4. a failing log update still yields 500
  {
    const out = await handleOrderWrite(
      async () => ({ error: 'boom' }),
      async () => {
        throw new Error('log down')
      },
    )
    expect('markFailed throwing still yields 500', out.status === 500)
  }
  expect('non-string error is handled', safeOrderError(undefined) === 'unknown error')

  // 5. the Needs attention count
  const fakeAdmin = (rows: unknown[] | null, error: unknown = null, throws = false) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      not: () => q,
      gte: () => q,
      limit: async () => {
        if (throws) throw new Error('no table')
        return { data: rows, error }
      },
    }
    return { from: () => q }
  }
  expect('no failed events -> count 0', (await orderWebhookFailureCount(fakeAdmin([]))) === 0)
  expect('two failed events -> count 2', (await orderWebhookFailureCount(fakeAdmin([{ id: 'a' }, { id: 'b' }]))) === 2)
  expect('query error -> count 0', (await orderWebhookFailureCount(fakeAdmin(null, { message: 'missing column' }))) === 0)
  expect('thrown query -> count 0', (await orderWebhookFailureCount(fakeAdmin(null, null, true))) === 0)

  // 6. plain steps for the item
  const plain = plainAction({ id: ORDER_WEBHOOK_ISSUE_ID, area: 'system', title: '2 paid orders from GoHighLevel could not be saved', detail: 'x', fix: 'y' })
  expect('plain steps exist', plain.steps.length >= 3)
  expect('plain steps have no em dash', !plain.steps.concat(plain.why).some((s) => s.includes('—')))
  expect('plain steps link out', plain.url.startsWith('https://'))

  if (failures) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll checks passed')
}
main()
