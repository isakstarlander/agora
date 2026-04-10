import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ExternalLink, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { AccountabilityResult } from '@/lib/actions/accountability'

interface Props {
  layers: AccountabilityResult['layers']
  locale: string
}

export function AccountabilityLayers({ layers }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

      {/* Layer 1 — Promises */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="text-primary font-mono">①</span>
            Vallöften
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {layers.promises.length === 0 && (
            <p className="text-xs text-muted-foreground">Inga relevanta löften hittades.</p>
          )}
          {layers.promises.map((p, i) => (
            <div key={i} className="space-y-0.5">
              <p className="text-xs leading-relaxed">{p.text}</p>
              {p.category_name && (
                <p className="text-xs text-muted-foreground">{p.category_name} · {p.election_year}</p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Layer 2 — Legislation */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="text-primary font-mono">②</span>
            Lagstiftning
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {layers.legislation.length === 0 && (
            <p className="text-xs text-muted-foreground">Inga relevanta dokument hittades.</p>
          )}
          {layers.legislation.map(doc => (
            <div key={doc.id} className="flex items-start gap-2">
              <Badge variant="outline" className="shrink-0 text-xs">{doc.type}</Badge>
              <div className="min-w-0">
                {doc.source_url ? (
                  <a
                    href={doc.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs hover:underline flex items-center gap-1"
                  >
                    <span className="line-clamp-2">{doc.title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <p className="text-xs line-clamp-2">{doc.title}</p>
                )}
                <p className="text-xs text-muted-foreground">{doc.rm}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Layer 3 — Votes */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="text-primary font-mono">③</span>
            Voteringar
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {layers.votes.length === 0 && (
            <p className="text-xs text-muted-foreground">Inga relevanta voteringar hittades.</p>
          )}
          {layers.votes.map(v => (
            <div key={v.vote_id} className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground truncate flex-1">
                {v.description ?? v.vote_id}
              </p>
              <Badge
                variant={v.party_position === 'Ja' ? 'default' : v.party_position === 'Nej' ? 'destructive' : 'secondary'}
                className="shrink-0 text-xs"
              >
                {v.party_position}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Layer 4 — Budget */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="text-primary font-mono">④</span>
            Budget (ESV utfall)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {layers.budget.length === 0 && (
            <p className="text-xs text-muted-foreground">Inga relevanta budgetposter hittades.</p>
          )}
          {layers.budget.slice(0, 8).map((b, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs truncate">{b.expenditure_area_name ?? b.expenditure_area_code}</p>
                <p className="text-xs text-muted-foreground">{b.year}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs font-mono">
                  {b.utfall_sek !== null
                    ? `${(b.utfall_sek / 1e9).toFixed(1)} mdr`
                    : '—'}
                </span>
                {b.delta_pct !== null && (
                  b.delta_pct > 0
                    ? <TrendingUp className="h-3 w-3 text-green-600" />
                    : b.delta_pct < 0
                      ? <TrendingDown className="h-3 w-3 text-red-500" />
                      : <Minus className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

    </div>
  )
}
