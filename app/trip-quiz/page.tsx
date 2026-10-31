import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ItineraryRequestForm } from "@/components/itinerary-request-form"
import { getVisitorPreferences, type Language } from "@/lib/preferences"
import { SITE_NAME, pageAlternates, priceOnRequestLine } from "@/lib/site"
import { todayYmd } from "@/lib/past-trip"
import { loadTripKit } from "@/lib/trip-kit-store"
import { mayShowPrice, priceConfirmedLine } from "@/lib/trip-kit-facts"
import { getTripQuizMode, listQuizTrips, recordQuizEvent } from "@/lib/trip-quiz-store"
import { QUIZ_KEYS, QUIZ_PARAM, QUIZ_QUESTIONS, answerLabel, isCompleteAnswers, matchTrips, parseQuizAnswers, quizStep, type QuizAnswers, type QuizMatch } from "@/lib/trip-quiz"

// "Find your trip in 60 seconds" (lib/trip-quiz.ts). Four questions, one per screen, then up to three trips picked by plain rules from
// the stored fields of published trips. Every screen is an ordinary server rendered page and every answer is a plain link, so it works
// on any phone, with or without JavaScript. Only the final form (the same itinerary form, with its unticked consent box) needs the browser.
//
// Off by default: with app_settings trip_quiz_mode not "on" this page is a 404 and nothing is counted or loaded.
// The funnel is counted on the server as screens are served (no cookie, no script). A refresh counts again, so the numbers are close, not exact.
export const dynamic = "force-dynamic"

type Query = Record<string, string | string[] | undefined>

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const
const TITLE = `Find your trip in 60 seconds | ${SITE_NAME}`
const DESCRIPTION = "Answer four quick questions about who is travelling, the kind of trip, when and how long, and see the trips that fit. Real trips, real dates, no guessing."

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/** The campaign tags carried along every link so the existing source capture still works. */
function utmOf(query: Query): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of UTM_KEYS) {
    const v = first(query[k])
    if (v) out[k] = v.slice(0, 200)
  }
  return out
}

function quizHref(answers: Partial<QuizAnswers>, utm: Record<string, string>): string {
  const p = new URLSearchParams()
  for (const k of QUIZ_KEYS) {
    const v = answers[k]
    if (v) p.set(QUIZ_PARAM[k], v)
  }
  for (const [k, v] of Object.entries(utm)) p.set(k, v)
  const q = p.toString()
  return q ? `/trip-quiz?${q}` : "/trip-quiz"
}

export async function generateMetadata({ searchParams }: { searchParams: Query }): Promise<Metadata> {
  const answered = Object.keys(parseQuizAnswers(searchParams)).length > 0
  return {
    title: TITLE,
    description: DESCRIPTION,
    // Always one canonical address; the in-progress and result screens are not separate pages for search.
    alternates: pageAlternates("/trip-quiz"),
    ...(answered ? { robots: { index: false, follow: true } } : {}),
  }
}

export default async function TripQuizPage({ searchParams }: { searchParams: Query }) {
  if ((await getTripQuizMode()) !== "on") notFound()

  const { language, currency } = getVisitorPreferences()
  const answers = parseQuizAnswers(searchParams)
  const step = quizStep(answers)
  const utm = utmOf(searchParams)

  let body: React.ReactNode
  if (step < 4) {
    // Counting: the first screen with nothing answered is "started"; the screen for question N+1 means question N was answered.
    await recordQuizEvent(step === 0 ? "started" : (`q${step}` as "q1" | "q2" | "q3"))
    body = <QuestionScreen step={step} answers={answers} utm={utm} />
  } else {
    await recordQuizEvent("q4")
    await recordQuizEvent("result")
    body = await ResultScreen({ answers: answers as QuizAnswers, utm, language })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header language={language} currency={currency} />
      <main className="flex-1">
        <div className="container mx-auto max-w-2xl px-4 py-8 sm:py-12">
          <h1 className="text-balance text-center text-3xl font-bold text-foreground sm:text-4xl">Find your trip in 60 seconds</h1>
          {body}
        </div>
      </main>
      <Footer language={language} />
    </div>
  )
}

function QuestionScreen({ step, answers, utm }: { step: number; answers: Partial<QuizAnswers>; utm: Record<string, string> }) {
  const q = QUIZ_QUESTIONS[step]
  const backAnswers: Partial<QuizAnswers> = {}
  for (const k of QUIZ_KEYS.slice(0, Math.max(0, step - 1))) (backAnswers as Record<string, string | undefined>)[k] = answers[k]
  return (
    <section aria-labelledby="quiz-question" className="mt-6">
      <div className="mb-2 flex items-center justify-between text-sm font-medium text-muted-foreground">
        <span>Question {step + 1} of 4</span>
        {step > 0 ? (
          <a href={quizHref(backAnswers, utm)} className="inline-flex min-h-11 items-center px-2 underline">Back</a>
        ) : (
          <Link href="/" className="inline-flex min-h-11 items-center px-2 underline">Home</Link>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={step} aria-label="Quiz progress">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(step / 4) * 100}%` }} />
      </div>
      <h2 id="quiz-question" className="mt-6 text-balance text-center text-2xl font-bold text-foreground">{q.title}</h2>
      {step === 0 && <p className="mt-2 text-center text-muted-foreground">Four quick questions, one at a time. You can go back at any point.</p>}
      <ul className="mt-6 space-y-3">
        {q.options.map((o) => (
          <li key={o.value}>
            <a
              href={quizHref({ ...answers, [q.key]: o.value } as Partial<QuizAnswers>, utm)}
              className="flex min-h-14 w-full items-center rounded-xl border-2 bg-card px-5 py-4 text-lg font-semibold text-foreground shadow-sm hover:border-primary hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            >
              {o.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

async function ResultScreen({ answers, utm, language }: { answers: QuizAnswers; utm: Record<string, string>; language: Language }) {
  const today = todayYmd()
  const trips = await listQuizTrips()
  const { matches, noMatch } = isCompleteAnswers(answers) ? matchTrips(answers, trips, today) : { matches: [] as QuizMatch[], noMatch: true }
  const phone = priceOnRequestLine().phone
  const startAgain = quizHref({}, utm)
  const backAnswers: Partial<QuizAnswers> = { who: answers.who, style: answers.style, when: answers.when }

  const summary = QUIZ_KEYS.map((k) => answerLabel(k, answers[k])).join(", ")

  if (noMatch) {
    return (
      <section aria-labelledby="quiz-result" className="mt-6">
        <h2 id="quiz-result" className="text-balance text-center text-2xl font-bold text-foreground">We do not have a close match right now</h2>
        <p className="mt-3 text-center text-muted-foreground">Your answers: {summary}.</p>
        <p className="mt-3 text-center text-foreground">We would rather say so than show you a trip that does not really fit. A travel advisor can look beyond what is listed on this site and tell you what is coming up.</p>
        <div className="mt-6 flex flex-col items-center gap-3">
          {phone && <p className="text-lg">Call or text <strong>{phone}</strong></p>}
          <Link href="/#contact" className="inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-6 py-3 font-bold text-primary-foreground hover:bg-primary/90">Talk to an agent</Link>
          <a href={quizHref(backAnswers, utm)} className="inline-flex min-h-11 items-center px-2 underline">Change my last answer</a>
          <a href={startAgain} className="inline-flex min-h-11 items-center px-2 underline">Start again</a>
        </div>
      </section>
    )
  }

  // A price shows only when an agent confirmed one for that trip (the same record and the same line the trip page uses).
  const priced = await Promise.all(
    matches.map(async (m) => {
      const id = trips.find((t) => t.slug === m.slug)?.id
      const rec = id ? await loadTripKit(id) : null
      return { m, price: rec && mayShowPrice(rec.price) && rec.price ? priceConfirmedLine(rec.price) : null }
    }),
  )
  const top = matches[0]
  const slugs = matches.map((m) => m.slug)
  const tripBy = (slug: string) => trips.find((t) => t.slug === slug)

  return (
    <section aria-labelledby="quiz-result" className="mt-6">
      <h2 id="quiz-result" className="text-balance text-center text-2xl font-bold text-foreground">{matches.length === 1 ? "Here is the trip that fits" : `Here are ${matches.length} trips that fit`}</h2>
      <p className="mt-2 text-center text-muted-foreground">Your answers: {summary}.</p>
      <ol className="mt-6 space-y-4">
        {priced.map(({ m, price }) => {
          const t = tripBy(m.slug)
          return (
            <li key={m.slug} className="rounded-xl border bg-card p-5 shadow-sm">
              <h3 className="text-xl font-bold text-foreground">{m.name}</h3>
              {t && (t.destination || t.duration) && <p className="mt-1 text-muted-foreground">{[t.destination, t.duration].filter(Boolean).join(", ")}</p>}
              <ul className="mt-3 list-disc space-y-1 pl-5 text-foreground">
                {m.reasons.map((r) => <li key={r}>This trip {r}</li>)}
              </ul>
              <p className="mt-3 text-sm">
                <span className="font-semibold">Next confirmed dates: </span>
                {m.dates.length > 0 ? m.dates.join("; ") : <span className="italic text-muted-foreground">Your agent will confirm the dates.</span>}
              </p>
              {price && (
                <p className="mt-2">
                  <span className="text-lg font-extrabold">{price.headline}</span>
                  <span className="block text-xs text-muted-foreground">{price.note}</span>
                </p>
              )}
              <Link href={`/packages/${m.slug}`} className="mt-3 inline-flex min-h-11 items-center font-semibold underline">See the whole trip</Link>
            </li>
          )
        })}
      </ol>

      <div className="mt-8 rounded-xl border bg-muted/30 p-5" id="quiz-itinerary">
        <h2 className="text-xl font-bold text-foreground">Send me the full itinerary and dates</h2>
        <p className="mb-4 mt-1 text-muted-foreground">for {top.name}. You get a private page you can print. It shows only what we have confirmed.</p>
        <ItineraryRequestForm slug={top.slug} language={language} quiz={{ ...answers, slugs }} submitLabel="Send me the full itinerary and dates" />
      </div>
      <p className="mt-6 text-center">
        <a href={quizHref(backAnswers, utm)} className="inline-flex min-h-11 items-center px-2 underline">Change my last answer</a>
        <span aria-hidden="true"> | </span>
        <a href={startAgain} className="inline-flex min-h-11 items-center px-2 underline">Start again</a>
      </p>
    </section>
  )
}
