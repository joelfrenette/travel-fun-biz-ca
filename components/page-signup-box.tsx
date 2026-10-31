import { TripAlertForm } from "@/components/trip-alert-form"
import type { Language } from "@/lib/preferences"
import { translate } from "@/lib/i18n"
import { TripQuizCard } from "@/components/trip-quiz-card"

// The email-only signup box under the content of guide, blog, compare and best-time pages. It reuses TripAlertForm as
// is (email, optional name, UNTICKED CASL consent box with its existing wording, honeypot, posts to /api/trip-alerts),
// and passes the page path as `source` so the lead shows which page it came from. Render it at most once per page.
// Server component: the heading is plain markup, so it adds no layout shift; the form is the only client part.
export function PageSignupBox({ path, language }: { path: string; language: Language }) {
  return (
    <>
      {/* The trip quiz card: renders nothing unless app_settings trip_quiz_mode is on (lib/trip-quiz.ts). */}
      <TripQuizCard className="mb-6" />
      <section id="page-signup" aria-labelledby="page-signup-heading" className="rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8">
        <h2 id="page-signup-heading" className="mb-4 text-balance text-xl font-bold text-foreground">{translate(language, "Hear about our next trips")}</h2>
        <TripAlertForm source={path} language={language} />
      </section>
    </>
  )
}
