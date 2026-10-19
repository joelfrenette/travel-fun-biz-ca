// A request body that must be a JSON object. null (array, string, number, null, bad JSON) is answered with a 400 by the caller.
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const BAD_BODY_MESSAGE = 'Send the details as a JSON object.'
