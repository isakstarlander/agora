import { Ratelimit } from '@upstash/ratelimit'
import { Redis }     from '@upstash/redis'
import { NextRequest } from 'next/server'

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// One limiter per tier × route class
const limiters = {
  // Anonymous (IP-keyed)
  anon_general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30,  '1 m'), prefix: 'agora:anon:general' }),
  anon_search:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10,  '1 m'), prefix: 'agora:anon:search' }),

  // Free key
  free_general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(120, '1 m'), prefix: 'agora:free:general' }),
  free_search:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30,  '1 m'), prefix: 'agora:free:search' }),
  free_account: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10,  '1 m'), prefix: 'agora:free:account' }),

  // Paid key
  paid_general: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(600, '1 m'), prefix: 'agora:paid:general' }),
  paid_search:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(120, '1 m'), prefix: 'agora:paid:search' }),
  paid_account: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60,  '1 m'), prefix: 'agora:paid:account' }),
} as const

type RouteClass = 'general' | 'search' | 'account'
type Tier = 'anon' | 'free' | 'paid'

function getIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

export async function checkRateLimit(
  req: NextRequest,
  routeClass: RouteClass,
  keyId?: string,         // undefined = anonymous
  tier?: 'free' | 'paid',
): Promise<{ allowed: boolean; retryAfter: number }> {
  const resolvedTier: Tier = !keyId ? 'anon' : tier ?? 'free'
  const limiterKey = `${resolvedTier}_${routeClass}` as keyof typeof limiters
  const limiter    = limiters[limiterKey]
  const identifier = keyId ?? getIp(req)

  const { success, reset } = await limiter.limit(identifier)
  const retryAfter = Math.ceil((reset - Date.now()) / 1000)
  return { allowed: success, retryAfter: success ? 0 : retryAfter }
}
