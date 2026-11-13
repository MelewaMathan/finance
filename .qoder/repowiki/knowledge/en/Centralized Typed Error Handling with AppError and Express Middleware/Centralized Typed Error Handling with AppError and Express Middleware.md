---
kind: error_handling
name: Centralized Typed Error Handling with AppError and Express Middleware
category: error_handling
scope:
    - '**'
source_files:
    - backend/src/lib/errors.ts
    - backend/src/middleware/error.ts
    - backend/src/app.ts
    - frontend/src/lib/api.ts
    - frontend/src/lib/errors.ts
---

## Approach

The SecureMicrofinance backend uses a **typed sentinel-error** pattern centered on a single `AppError` class, combined with an Express error-handling middleware that normalizes every response into a stable JSON shape. The frontend mirrors this contract with its own `ApiError` type and helpers for rendering validation fields.

## Key Files

- `backend/src/lib/errors.ts` — defines `AppError` and factory helpers (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `locked`, `tooMany`).
- `backend/src/middleware/error.ts` — registers `notFoundHandler` (404 for unknown routes) and `errorHandler` (central Express error handler).
- `backend/src/app.ts` — wires `notFoundHandler` and `errorHandler` as the last two Express middlewares.
- `frontend/src/lib/api.ts` — defines `ApiError` (mirrors the server payload: `status`, `code`, `message`, `details`, `requestId`) and handles 401 refresh/retry.
- `frontend/src/lib/errors.ts` — client-side helpers `fieldErrors` and `messageOf` that consume the server's normalized error envelope.

## Architecture and Conventions

### Backend error types

`AppError` extends `Error` and carries four fields:

| Field | Purpose |
|---|---|
| `status` | HTTP status code (400/401/403/404/409/422/423/429) |
| `code` | Stable machine-readable string (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE`, `LOCKED`, `RATE_LIMITED`) |
| `message` | User-facing text |
| `details?` | Optional extra context (e.g. Zod issue array, constraint name) |

Every business-layer throw goes through one of the factory helpers in `lib/errors.ts`; raw `throw new Error(...)` is not used for application-level failures. This is visible across `modules/auth/auth.service.ts`, `modules/auth/token.service.ts`, `modules/users/users.routes.ts`, and `middleware/auth.ts`.

### Centralized response normalization

`errorHandler` in `middleware/error.ts` is the single point where all errors are turned into JSON:

```
{
  "error": {
    "code": "...",
    "message": "...",
    "details": "...",
    "requestId": "..."
  }
}
```

It dispatches by type:

1. `instanceof AppError` → echo `status`/`code`/`message`/`details`.
2. `instanceof ZodError` → 400 with `VALIDATION_ERROR` and a mapped `issues[]` array of `{ path, message }`.
3. PostgreSQL error codes → maps raw DB codes to semantic API codes:
   - `23505` (unique violation) → 409 `DUPLICATE` with optional `constraint` detail.
   - `23514` / `23503` (check/fk violations) → 422 `CONSTRAINT_VIOLATION`.
   - `23001` / `23000` (insufficient privilege) → 409 `APPEND_ONLY`.
4. Fallback → 500 `INTERNAL_ERROR`. Internal details (`error.message`) are included only when `config.isProduction` is false; production clients receive only `hint: undefined`.

Every response includes a `requestId` taken from `req.requestId` (set by `requestContext` middleware), enabling end-to-end tracing.

### Unknown routes

`notFoundHandler` returns 404 `NOT_FOUND` for any unmatched route, explicitly documented as never leaking the route table.

### Frontend mirror

The client defines `ApiError` with the same shape (`status`, `code`, `message`, `details`) and throws it whenever `fetch` returns a non-OK response. A shared `api()` wrapper adds 401 retry via `refreshAccessToken()`, which deduplicates concurrent refresh attempts using a single `bootstrapInFlight` promise.

`fieldErrors(error)` converts a Zod-style `details[]` payload into a `{ field: message }` map keyed by the last segment of the dotted path, so form components can render inline hints. `messageOf(error)` is a safe fallback for displaying any thrown value to users.

## Conventions and Constraints

- **Application errors are thrown as `AppError` instances** created via the factory helpers in `lib/errors.ts`. All observed throws in `modules/auth/*`, `modules/users/*`, and `middleware/auth.ts` follow this pattern.
- **Business logic does not return error objects**; it throws. The single `errorHandler` middleware is the only place that constructs HTTP responses for errors.
- **Database errors are translated at the boundary.** Raw PostgreSQL error codes (`23505`, `23514`, `23503`, `23001`, `23000`) are caught in `errorHandler` and mapped to semantic API codes; SQL messages are never sent to clients.
- **Validation errors flow through Zod** and are converted to a 400 `VALIDATION_ERROR` with a `details` array of `{ path, message }` entries. The frontend helper `fieldErrors` expects exactly this shape.
- **Client-facing error envelopes are uniform**: `{ error: { code, message, details?, requestId } }`. Both server and client reference these fields directly.
- **Internal diagnostics are gated behind `config.isProduction`**. In production, the 500 response omits `details`; in development it includes `hint: error.message`.
- **Unknown endpoints always return 404 `NOT_FOUND`**, regardless of whether the request reached a route or fell through to the error handler.
- **No use of `process.exit`, `console.error` for user output, or unhandled rejections** in the error paths shown — the central handler is the sole sink for error logging (`console.error([error] ${requestId} ...)`).
- **Frontend `ApiError` mirrors the server contract** so callers can branch on `error.code` (e.g. `UNAUTHORIZED` triggers token refresh) rather than inspecting raw HTTP status alone.