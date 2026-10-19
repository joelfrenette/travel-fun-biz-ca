// Decides what the GoHighLevel webhook answers after it tries to save an order. Pure on purpose: the
// route passes in the real saver, a check passes in a fake one. A failed save must NOT look like a
// success, otherwise GoHighLevel never retries and a paid order silently goes missing from the ledger.
// Retrying is safe because the orders table upserts on provider + provider_order_id.

export interface OrderWriteOutcome {
  status: 200 | 500
  /** Short, personal-data-free reason, only set on a failure. */
  errorText?: string
}

/** Keeps a database error short and removes anything that looks like personal data or a key value. */
export function safeOrderError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : 'unknown error'
  const cleaned = text
    .replace(/[^\s@]+@[^\s@]+/g, '[removed]')
    .replace(/\([^)]*\)/g, '(...)')
    .replace(/\d[\d\s().+-]{5,}\d/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'unknown error').slice(0, 120)
}

/**
 * Runs the order save. `save` is the real recordOrder call (already bound to its arguments).
 * `markFailed` records the failure on the already-logged webhook_events row (status 500 plus the short
 * reason); it must never throw out of here, a failing log must not hide the 500.
 */
export async function handleOrderWrite(
  save: () => Promise<{ error?: string }>,
  markFailed: (errorText: string) => Promise<void>,
): Promise<OrderWriteOutcome> {
  let failure: string | null = null
  try {
    const result = await save()
    if (result && result.error) failure = safeOrderError(result.error)
  } catch (e) {
    failure = safeOrderError(e)
  }
  if (failure === null) return { status: 200 }
  try {
    await markFailed(failure)
  } catch {
    // the 500 below is what makes GoHighLevel retry; the log line is a bonus
  }
  return { status: 500, errorText: failure }
}

/**
 * Counts order saves that failed in the last 7 days (webhook_events rows with status 500 and an
 * order_error note in the payload). Returns null when there are none, or when the table or a column
 * cannot be read: an unreadable log is never worth failing the Needs attention list.
 */
export async function orderWebhookFailureCount(
  admin: { from: (t: string) => any },
  now: Date = new Date(),
): Promise<number> {
  try {
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const { data, error } = await admin
      .from('webhook_events')
      .select('id')
      .eq('status', 500)
      .not('payload->order_error', 'is', null)
      .gte('created_at', since)
      .limit(200)
    if (error || !Array.isArray(data)) return 0
    return data.length
  } catch {
    return 0
  }
}
