// ONE definition of "this is a test, not a real person". Test leads, test signups and test sales are
// made-up people used to try the forms and the payment link. They must never count in any report,
// dashboard, funnel, KPI or the daily brief, and they must never raise an alert about a real customer.
// Everything that counts leads or orders filters on the is_test flag this decides, so a new report only
// needs `.eq('is_test', false)`.
//
// A person is a test when the email uses a reserved fake domain (example.com, example.org, example.net),
// a reserved fake ending (.test, .invalid, .localhost), or starts with "claude-test"; or the name starts
// with "TEST LEAD" or "[TEST]". Add a pattern here if the owner starts using another one.
const FAKE_EMAIL = /(@example\.(com|org|net)|\.(test|invalid|localhost))$/i
const TEST_LOCAL_PART = /^claude-test/i
const TEST_NAME = /^(test lead|\[test\])/i

export function isTestEmail(email: string | null | undefined): boolean {
  const e = (email ?? '').trim()
  return !!e && (FAKE_EMAIL.test(e) || TEST_LOCAL_PART.test(e.split('@')[0] ?? ''))
}

export function isTestPerson(p: { email?: string | null; name?: string | null }): boolean {
  return isTestEmail(p.email) || TEST_NAME.test((p.name ?? '').trim())
}
