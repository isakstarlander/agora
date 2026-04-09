import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { ApiRequestError } from './errors'
import { err, internalError } from './response'
import { CORS_HEADERS } from './cors'

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>

export function apiRoute(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
    }
    try {
      return await handler(req, ctx)
    } catch (e) {
      if (e instanceof ApiRequestError) {
        return err(e.code, e.message, e.status)
      }
      if (e instanceof ZodError) {
        return err('BAD_REQUEST', e.issues[0]?.message ?? 'Invalid parameters', 400)
      }
      console.error('[api]', e)
      return internalError()
    }
  }
}
