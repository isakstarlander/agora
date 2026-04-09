import { createEnv } from '@t3-oss/env-nextjs'
import { z } from 'zod'

export const env = createEnv({
  server: {
    SUPABASE_SECRET_KEY:        z.string().min(1),
    ANTHROPIC_API_KEY:          z.string().min(1),
    UPSTASH_REDIS_REST_URL:     z.url(),
    UPSTASH_REDIS_REST_TOKEN:   z.string().min(1),
    AGORA_INTERNAL_API_KEY:     z.string().startsWith('agora_'),
    MANIFESTO_API_KEY:          z.string().optional(),
    DEEPL_API_KEY:              z.string().optional(),
    SENTRY_AUTH_TOKEN:          z.string().optional(),
    SENTRY_ORG:                 z.string().optional(),
    SENTRY_PROJECT:             z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL:            z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_POSTHOG_KEY:             z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST:            z.url().optional(),
    NEXT_PUBLIC_SENTRY_DSN:              z.string().optional(),
  },
  runtimeEnv: {
    SUPABASE_SECRET_KEY:                 process.env.SUPABASE_SECRET_KEY,
    ANTHROPIC_API_KEY:                   process.env.ANTHROPIC_API_KEY,
    UPSTASH_REDIS_REST_URL:              process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN:            process.env.UPSTASH_REDIS_REST_TOKEN,
    AGORA_INTERNAL_API_KEY:              process.env.AGORA_INTERNAL_API_KEY,
    MANIFESTO_API_KEY:                   process.env.MANIFESTO_API_KEY,
    DEEPL_API_KEY:                       process.env.DEEPL_API_KEY,
    SENTRY_AUTH_TOKEN:                   process.env.SENTRY_AUTH_TOKEN,
    SENTRY_ORG:                          process.env.SENTRY_ORG,
    SENTRY_PROJECT:                      process.env.SENTRY_PROJECT,
    NEXT_PUBLIC_SUPABASE_URL:            process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_POSTHOG_KEY:             process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST:            process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_SENTRY_DSN:              process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
})
