import { NextResponse } from 'next/server'
import { CORS_HEADERS } from './cors'

export interface Meta {
  total?:       number
  page?:        number
  per_page?:    number
  cursor?:      string
  sources?:     string[]
  generated_at: string
}

export interface ApiSuccess<T> {
  data: T
  meta: Meta
}

export interface ApiError {
  error: {
    code:    string
    message: string
    status:  number
  }
}

function withCors(res: NextResponse): NextResponse {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v))
  return res
}

export function ok<T>(data: T, meta: Partial<Meta> = {}): NextResponse {
  const body: ApiSuccess<T> = {
    data,
    meta: { generated_at: new Date().toISOString(), ...meta },
  }
  return withCors(NextResponse.json(body, { status: 200 }))
}

export function paginated<T>(
  data: T[],
  total: number,
  page: number,
  perPage: number,
  extra: Partial<Meta> = {},
): NextResponse {
  return ok(data, { total, page, per_page: perPage, ...extra })
}

export function err(
  code: string,
  message: string,
  status: number,
): NextResponse {
  const body: ApiError = { error: { code, message, status } }
  return withCors(NextResponse.json(body, { status }))
}

export function notFound(resource = 'Resource'): NextResponse {
  return err('NOT_FOUND', `${resource} not found`, 404)
}

export function badRequest(message: string): NextResponse {
  return err('BAD_REQUEST', message, 400)
}

export function rateLimited(retryAfter: number): NextResponse {
  return err('RATE_LIMITED', `Försök igen om ${retryAfter} sekunder.`, 429)
}

export function internalError(): NextResponse {
  return err('INTERNAL_ERROR', 'Ett oväntat fel uppstod.', 500)
}
