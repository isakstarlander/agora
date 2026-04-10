import { NextResponse } from 'next/server'
import { generateOpenApiSpec } from '@/lib/api/openapi/spec'
import { CORS_HEADERS } from '@/lib/api/cors'

export function GET() {
  const spec = generateOpenApiSpec()
  return NextResponse.json(spec, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}
