import { getTripQuizMode } from "@/lib/trip-quiz-store"
import { TripQuizLink } from "@/components/trip-quiz-link"

// The small "Find your trip in 60 seconds" card (lib/trip-quiz.ts). Server component: with app_settings trip_quiz_mode not "on"
// (the default, and any read problem) it renders nothing at all, so a page that includes it is unchanged.
// Placed on the home page, beside the signup box on guide, blog, compare and best-time pages.
async function TripQuizCardImpl({ className = "" }: { className?: string }) {
  if ((await getTripQuizMode()) !== "on") return null
  return (
    <section aria-labelledby="trip-quiz-card-heading" className={`rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8 ${className}`.trim()}>
      <h2 id="trip-quiz-card-heading" className="text-balance text-xl font-bold text-foreground">Find your trip in 60 seconds</h2>
      <p className="mx-auto mt-2 max-w-xl text-muted-foreground">Answer four quick questions and we will show you the trips that fit. No sign up needed to see them.</p>
      <TripQuizLink className="mt-4 inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-6 py-3 font-bold text-primary-foreground hover:bg-primary/90">
        Start the 4 question quiz
      </TripQuizLink>
    </section>
  )
}

// Next renders an async server component directly; this project's TypeScript version does not know that, so the type says "a component".
export const TripQuizCard = TripQuizCardImpl as unknown as (props: { className?: string }) => JSX.Element
