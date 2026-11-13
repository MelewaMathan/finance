---
kind: frontend_style
name: Tailwind CSS Design System with Shared Primitives
category: frontend_style
scope:
    - '**'
source_files:
    - frontend/tailwind.config.js
    - frontend/src/index.css
    - frontend/postcss.config.js
    - frontend/src/components/ui.tsx
---

## Approach

The frontend (`frontend/`) is a React + Vite SPA styled exclusively with **Tailwind CSS v3** (PostCSS pipeline via `postcss.config.js` enabling `tailwindcss` and `autoprefixer`). There are no SCSS, Sass, or CSS-in-JS libraries — styling lives in plain `.css` files consumed by Tailwind's `@layer` system.

## Key Files

- `frontend/tailwind.config.js` — design tokens (colors, fonts, shadows)
- `frontend/src/index.css` — global base styles + shared component classes via `@layer components`
- `frontend/postcss.config.js` — PostCSS pipeline (tailwindcss + autoprefixer)
- `frontend/src/components/ui.tsx` — presentational React primitives that wrap the shared CSS classes

## Architecture & Conventions

### Design Tokens (in `tailwind.config.js`)

- **Brand palette**: custom `brand.{50..900}` scale derived from emerald (`#10b981` at 500), used for primary actions, focus rings, and accents.
- **Ink palette**: `ink.{700,800,900}` dark slate tones for active nav / high-emphasis text.
- **Typography**: `sans` family defaults to Inter with system fallbacks; `mono` uses ui-monospace stack.
- **Shadows**: a single `card` shadow token (`boxShadow.card`) applied via `shadow-card` utility.

### Layered CSS (`src/index.css`)

- `@layer base`: resets (`html -webkit-text-size-adjust`, body bg/text/font) and a global `:focus-visible` ring using `ring-brand-500`.
- `@layer components`: shared class names that pages compose:
  - Layout: `.card` (rounded-2xl, border, white bg, `shadow-card`)
  - Buttons: `.btn` base + variants `.btn-primary`, `.btn-brand`, `.btn-ghost`, `.btn-danger`
  - Form: `.label`, `.input`, `.hint`, `.error-text`
  - Navigation: `.nav-link`, `.nav-link-active`
  - Data: `.badge`, `.table-base` (thead/th, tbody/tr, td rules)

All component classes use `@apply` to compose Tailwind utilities — there are no hand-written layout rules beyond these layers.

### Component Primitives (`components/ui.tsx`)

A small set of presentational React components encapsulate the shared classes so pages stay readable. The file's JSDoc states the intent: "Pages compose these instead of repeating Tailwind class strings, which keeps the JSX readable and the UI consistent." Components include:

- `PageHeader`, `Card`, `StatCard` (with `tone` prop mapping to color classes)
- `Badge` (with `BadgeTone` map: neutral/success/warning/danger/info)
- `VerifiedBadge` (on-chain proof badge, green only when verified)
- `Field`, `TextInput`, `Select` (form field wrapper applying `.label` and `.input`)
- `Alert` (danger/warning/info tones)
- `EmptyState`, `Spinner`, `FullPageLoader`
- Inline SVG icons: `ShieldIcon`, `LogoMark`

Tones are centralized as JS objects inside the file rather than Tailwind config, keeping variant logic close to usage.

### Responsive Strategy

Mobile-first via Tailwind's responsive prefixes (e.g. `sm:flex-row sm:items-end sm:justify-between` on `PageHeader`). No media queries are written manually — breakpoints are the default Tailwind ones.

### Build Integration

- Vite consumes `index.html` → `src/main.tsx` → `App.tsx`.
- Tailwind scans `./index.html` and `./src/**/*.{ts,tsx}` per `tailwind.config.js` `content` glob.
- PostCSS runs tailwindcss then autoprefixer during the Vite build.

## Conventions Observed

- All visual variation goes through the `brand` and `ink` palettes defined in `tailwind.config.js`; ad-hoc hex values are avoided outside the config.
- Shared UI building blocks live in `src/index.css` under `@layer components` and are referenced by name (`.card`, `.btn`, `.input`, etc.) from both other CSS and JSX.
- Presentational React components in `ui.tsx` act as a thin layer over those CSS classes, accepting optional `className` props for composition.
- Focus accessibility is centralized via a single `:focus-visible` rule using `ring-brand-500`.
- The comment in `index.css` explicitly states the design-system goal: "Keeping the primitives here means pages stay readable and consistent, and the whole UI is mobile-first by default."

No external UI library (MUI, shadcn, Radix, etc.) is used — this is a homegrown primitive set built on top of Tailwind.