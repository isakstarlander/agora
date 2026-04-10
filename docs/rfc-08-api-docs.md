# RFC-08 — API Documentation

| Field  | Value |
|--------|-------|
| Status | Implemented |
| Date   | 2026-04-10 |
| Author | GitHub Copilot |
| Spec   | `api-first/08-api-docs.md` |

---

## Summary

Shipped a live, interactive API documentation page at `/docs` and completed the
OpenAPI 3.1 spec at `/api/v1/openapi`. Every endpoint implemented in RFCs 04–07 is
now registered in the spec. `tsc --noEmit` exits clean.

---

## Motivation

The infrastructure for spec generation (`@asteasolutions/zod-to-openapi`, the registry
singleton, and the `/api/v1/openapi` route handler) was already in place from earlier
RFCs. However only three paths were registered — `POST /keys/request`,
`GET /accountability`, and `GET /parties/{party}/alignment`. The remaining 14 paths
were dark. The `/docs` page did not exist at all, so external developers had no
interactive way to discover or test the API.

---

## Decisions

### `/docs` implemented as a Route Handler, not a page component

The spec prescribes a React page component (`app/docs/page.tsx`) that returns an
`<html>/<body>` shell. In practice this conflicts with Next.js App Router: the root
`layout.tsx` unconditionally renders its own `<html lang="sv"><body>` wrapper around
every page segment, producing two nested `<html>` elements. React warns loudly and
the Swagger UI hydration fails.

The fix is to move the entry point from `app/docs/page.tsx` to `app/docs/route.ts` — a
Route Handler that returns a plain `Response` with `Content-Type: text/html`. Route
Handlers are served directly by Next.js without processing through the component tree
or any layout, so the standalone HTML shell is delivered exactly as written.

### `extendZodWithOpenApi(z)` called in registry.ts, not in spec.ts

`@asteasolutions/zod-to-openapi` adds `.openapi()` to Zod schemas by mutating the
`ZodType.prototype`. This mutation must happen before any schema that calls `.openapi()`
is evaluated. Because `spec.ts` is the first consumer of the registry and because
multiple other route files may eventually import the registry and define schemas,
`extendZodWithOpenApi(z)` is called inside `registry.ts` — the single file that is
always imported first. Calling it in `spec.ts` (as the product request suggests) works
locally but is fragile: any future route file that imports the registry directly and
calls `.openapi()` would fail if that file happened to be evaluated before `spec.ts`.

Note: `registry.register('Name', schema)` also internally calls `.openapi()` on the
schema. Placing the `extendZodWithOpenApi` call at the module level of `registry.ts`
guarantees it runs before any registration regardless of import order.

### Shared schemas (`ApiMeta`, `ApiError`) omitted

The spec includes `registry.register('ApiMeta', ...)` and `registry.register('ApiError', ...)`
for use as `$ref` targets in response objects. These were attempted but are only useful
when response schemas are fully described with `content: { 'application/json': { schema: ... } }`.
The existing path registrations (including those from RFC-07) use simple
`{ description: string }` response objects and do not reference these components.
Adding the registrations without wiring them into response schemas produces components
that appear in the spec but are never referenced, adding noise without value. They are
omitted until response schemas are fully described in a future RFC.

### `BearerAuth` security scheme registered via `registry.registerComponent`

The existing `GET /accountability` registration (from RFC-07) references
`security: [{ BearerAuth: [] }]` but the scheme was never declared in
`components/securitySchemes`. This caused the spec to reference an undefined component.
`registry.registerComponent('securitySchemes', 'BearerAuth', { ... })` is the correct
API — it produces the `components.securitySchemes.BearerAuth` entry in the generated
document and enables the Swagger UI "Authorize" dialog for testing the gated endpoint.

### Server URL changed from absolute to relative

The prior `generateOpenApiSpec` call used an absolute URL in the `servers` field.
This means Swagger UI's "Try it out" feature always targeted that origin, even when
running locally. Changed to `servers: [{ url: '/api/v1', description: 'Production' }]`
so requests go to the same origin the docs are served from — dev, preview, and
production all work without any configuration.

---

## Files Created

| File | Description |
|---|---|
| `apps/web/app/docs/route.ts` | Route Handler serving the standalone Swagger UI HTML page at `GET /docs` |

## Files Modified

| File | Change |
|---|---|
| `apps/web/lib/api/openapi/registry.ts` | Added `extendZodWithOpenApi(z)` call so `.openapi()` is available on all Zod schemas before any path is registered |
| `apps/web/lib/api/openapi/spec.ts` | Registered 14 missing paths (`/members`, `/members/{id}`, `/members/{id}/votes`, `/members/{id}/documents`, `/documents`, `/documents/{id}`, `/votes`, `/votes/{id}`, `/budget`, `/budget/areas`, `/parties`, `/parties/{party}/votes`, `/search`, `/search/manifesto`); added `BearerAuth` security scheme; changed server URL to relative `/api/v1` |
