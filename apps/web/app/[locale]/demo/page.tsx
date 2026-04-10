import { after } from 'next/server'
import { getTranslations } from 'next-intl/server'
import type { Metadata } from 'next'
import { fetchAccountability } from '@/lib/actions/accountability'
import { QueryWidget } from '@/components/features/demo/query-widget'
import { RequestKeyPanel } from '@/components/features/demo/request-key-panel'

export async function generateMetadata({
  params,
  searchParams,
}: {
  params:       Promise<{ locale: string }>
  searchParams: Promise<{ parti?: string; amne?: string }>
}): Promise<Metadata> {
  const sp    = await searchParams
  const title = sp.parti && sp.amne
    ? `Löfteskollen — ${sp.parti} om ${sp.amne}`
    : 'Löfteskollen — Håller ditt parti vad det lovar?'
  return {
    title,
    description:
      'Se hur svenska partier lever upp till sina vallöften — baserat på riksdagsdata, statsbudgeten och valmanifest.',
    openGraph: { title, type: 'website' },
  }
}

export default async function DemoPage({
  params,
  searchParams,
}: {
  params:       Promise<{ locale: string }>
  searchParams: Promise<{ parti?: string; amne?: string }>
}) {
  const { locale } = await params
  const sp         = await searchParams
  const t          = await getTranslations({ locale, namespace: 'demo' })

  // Fire demo_viewed analytics after response is sent — does not add latency
  after(async () => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key) return
    const { PostHog } = await import('posthog-node')
    const client = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com',
    })
    client.capture({ distinctId: 'anonymous', event: 'demo_viewed', properties: { locale } })
    await client.shutdown()
  })

  // Server-side pre-fetch if URL params are present (enables deep-linking)
  const initialResult = sp.parti && sp.amne
    ? await fetchAccountability(sp.parti, sp.amne)
    : null

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">

        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Löfteskollen</h1>
          <p className="text-muted-foreground text-lg">{t('tagline')}</p>
        </div>

        {/* Query widget owns all result rendering — initial server result passed as prop */}
        <QueryWidget
          initialParty={sp.parti ?? ''}
          initialTopic={sp.amne ?? ''}
          locale={locale}
          initialResult={initialResult}
        />

        {/* API key request panel */}
        <RequestKeyPanel />

        {/* API discovery link */}
        <p className="text-xs text-muted-foreground">
          {t('apiLink')}{' '}
          <a href="/docs" className="underline underline-offset-2">
            {t('apiDocs')}
          </a>
        </p>

      </div>
    </div>
  )
}
