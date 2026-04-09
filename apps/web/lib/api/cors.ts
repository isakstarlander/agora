import { NextRequest, NextResponse } from 'next/server'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control':                'public, s-maxage=60, stale-while-revalidate=300',
} as const

// Call this in every route file to handle OPTIONS preflight
export function handleOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// Wrap any route handler to inject CORS on all responses
export function withCors(
  handler: (req: NextRequest, ctx: unknown) => Promise<NextResponse>,
) {
  return async (req: NextRequest, ctx: unknown): Promise<NextResponse> => {
    if (req.method === 'OPTIONS') return handleOptions()
    const res = await handler(req, ctx)
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.headers.set(k, v))
    return res
  }
}
