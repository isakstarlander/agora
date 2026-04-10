'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { usePostHog } from 'posthog-js/react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, Loader2 } from 'lucide-react'
import { fetchAccountability, type AccountabilityResult } from '@/lib/actions/accountability'
import { AccountabilityLayers } from './accountability-layers'
import { SummaryCard } from './summary-card'
import { SourcesFooter } from './sources-footer'
import { PARTY_NAMES } from '@/lib/utils'

interface QueryWidgetProps {
  initialParty:  string
  initialTopic:  string
  locale:        string
  initialResult: { data: AccountabilityResult | null; error: string | null } | null
}

export function QueryWidget({ initialParty, initialTopic, locale, initialResult }: QueryWidgetProps) {
  const router   = useRouter()
  const pathname = usePathname()
  const posthog  = usePostHog()
  const [party, setParty]            = useState(initialParty)
  const [topic, setTopic]            = useState(initialTopic)
  const [result, setResult]          = useState<Awaited<ReturnType<typeof fetchAccountability>> | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!party || !topic || topic.length < 3) return

    // Update URL for shareability
    const params = new URLSearchParams({ parti: party, amne: topic })
    router.push(`${pathname}?${params.toString()}`, { scroll: false })

    startTransition(async () => {
      const res = await fetchAccountability(party, topic)
      setResult(res)

      if (res.data) {
        posthog?.capture('accountability_query', {
          party,
          topic_length:  topic.length,
          sources_count: res.data.sources.length,
        })
      }

      // Scroll to results
      setTimeout(() => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }), 100)
    })
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="flex gap-2 flex-wrap">
        <Input
          placeholder="Ange ett ämne, t.ex. klimat, bostäder, vård…"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          className="flex-1 min-w-48"
          minLength={3}
          maxLength={200}
          required
        />

        <Select value={party} onValueChange={(val) => val !== null && setParty(val)} required>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Välj parti" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PARTY_NAMES).map(([code, name]) => (
              <SelectItem key={code} value={code}>
                {code} — {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button type="submit" disabled={isPending || !party || topic.length < 3}>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-2">Kolla</span>
        </Button>
      </form>

      {/* Render client-side result after a query, or fall back to the server-pre-fetched initial result */}
      {(() => {
        const displayed = result ?? initialResult
        if (!displayed) return null
        return (
          <div className="space-y-6" id="results">
            {displayed.error && (
              <p className="text-destructive text-sm">{displayed.error}</p>
            )}
            {displayed.data && (
              <>
                <SummaryCard
                  summary={displayed.data.summary}
                  party={displayed.data.party}
                  topic={displayed.data.topic}
                />
                <AccountabilityLayers layers={displayed.data.layers} locale={locale} />
                <SourcesFooter sources={displayed.data.sources} party={displayed.data.party} />
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
