import createMiddleware from 'next-intl/middleware'
import type { NextRequest } from 'next/server'
import { routing } from './i18n/routing'

const intlHandler = createMiddleware(routing)

export function proxy(request: NextRequest) {
  return intlHandler(request)
}

export const config = {
  // Skip api routes, docs, Next internals, and static files
  matcher: ['/', '/((?!api|docs|_next|_vercel|.*\\..*).*)', '/(sv|en)/:path*'],
}
