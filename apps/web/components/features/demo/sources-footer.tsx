'use client'

import { useState } from 'react'
import { usePostHog } from 'posthog-js/react'
import { Button } from '@/components/ui/button'
import { Share2, Check, ChevronDown, ChevronUp } from 'lucide-react'

interface SourcesFooterProps {
  sources: string[]
  party:   string
}

export function SourcesFooter({ sources, party }: SourcesFooterProps) {
  const posthog                     = usePostHog()
  const [copied, setCopied]         = useState(false)
  const [expanded, setExpanded]     = useState(false)

  function handleShare() {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    posthog?.capture('demo_result_shared', { party })
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleShare} className="gap-1.5">
          {copied ? <Check className="h-3 w-3" /> : <Share2 className="h-3 w-3" />}
          {copied ? 'Kopierat!' : 'Dela länk'}
        </Button>
        <a
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center h-7 px-2.5 rounded-lg text-[0.8rem] hover:bg-muted hover:text-foreground"
        >
          Visa i API-dokumentation
        </a>
      </div>

      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {sources.length} källor
      </button>

      {expanded && (
        <div className="flex flex-wrap gap-1">
          {sources.map(s => (
            <code key={s} className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
              {s}
            </code>
          ))}
        </div>
      )}
    </div>
  )
}
