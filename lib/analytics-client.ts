// Thin wrapper over gtag so components never care whether GA4 is configured.
type Gtag = (command: 'event', name: string, params?: Record<string, string | number | boolean | undefined>) => void

export function track(event: string, params: Record<string, string | number | boolean | undefined> = {}): void {
  if (typeof window === 'undefined') return
  const gtag = (window as unknown as { gtag?: Gtag }).gtag
  if (typeof gtag !== 'function') return
  try {
    gtag('event', event, params)
  } catch {
    // Analytics must never break the page.
  }
}
