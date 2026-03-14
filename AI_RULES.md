# AI Rules for this app

## Tech stack (quick overview)

- **Next.js 14 (App Router)**: routes live under `app/` (e.g. `app/page.tsx`, API routes in `app/api/*/route.ts`).
- **React 19 + TypeScript**: all new components/pages should be `.tsx` with typed props.
- **Tailwind CSS v4**: primary styling approach; prefer utility classes over custom CSS.
- **shadcn/ui components**: reusable UI primitives in `components/ui/*`.
- **Radix UI**: underlying accessible primitives used by shadcn/ui (already installed).
- **lucide-react**: icon set for UI icons.
- **Forms/validation**: `react-hook-form` for form state + `zod` (and `@hookform/resolvers`) for schema validation.
- **Utilities**: `clsx` + `tailwind-merge` (via `lib/utils`) for className composition.

## Library usage rules (what to use for what)

### Routing & data fetching
- Use **Next.js App Router** conventions:
  - Pages: `app/**/page.tsx`
  - Layouts: `app/**/layout.tsx`
  - API routes: `app/api/**/route.ts`
- Do **not** add React Router.

### UI components
- Prefer **shadcn/ui** from `components/ui/*` for common UI (Button, Card, Input, Select, Tabs, Toast, etc.).
- If a shadcn/ui component exists, **use it instead of creating a bespoke version**.
- Do **not** edit `components/ui/*` directly unless absolutely necessary; build custom UI by composing these primitives in `components/`.

### Styling
- Use **Tailwind CSS** for all styling.
- Avoid adding new global CSS; only touch `app/globals.css` / `styles/globals.css` when required.
- For conditional classes, use `cn()` from `lib/utils` (combines `clsx` + `tailwind-merge`).

### Icons
- Use **lucide-react** icons.
- Avoid introducing additional icon libraries.

### Forms & validation
- Use **react-hook-form** for form state.
- Use **zod** for validation schemas.
- Connect them with `@hookform/resolvers/zod`.

### Toasts / notifications
- Use the existing toast setup (`hooks/use-toast` + `components/ui/toast` or the existing notification pattern in the codebase).
- Do not add a second toast/notification system.

### Dates, charts, and other utilities
- Use **date-fns** for date formatting and manipulation.
- Use **recharts** for charts.
- Avoid adding overlapping libraries (e.g., moment/dayjs).

## Project structure rules

- App routes: `app/`
- Shared components: `components/`
- UI primitives (shadcn/ui): `components/ui/`
- Shared utilities: `lib/` (e.g. `lib/utils.ts`)
- Hooks: `hooks/`
- Static assets: `public/`

## General coding rules

- Keep components small and composable; prefer composition over new abstractions.
- Use client components only when needed (`"use client"`), otherwise keep components server by default.
- Avoid adding new dependencies unless required by a clear feature need.
