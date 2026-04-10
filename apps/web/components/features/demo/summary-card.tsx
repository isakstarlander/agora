import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sparkles } from 'lucide-react'
import { PartyBadge } from '@/components/features/party-badge'

interface SummaryCardProps {
  summary: string | null
  party:   string
  topic:   string
}

export function SummaryCard({ summary, party, topic }: SummaryCardProps) {
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Sammanfattning
          <PartyBadge party={party} size="sm" />
          <span className="font-normal text-muted-foreground">om {topic}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {summary ? (
          <p className="text-sm leading-relaxed">{summary}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            AI-sammanfattning kunde inte genereras — se detaljerna nedan.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
