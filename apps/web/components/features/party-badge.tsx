import { cn } from '@/lib/utils'
import { PARTY_COLORS, PARTY_NAMES } from '@/lib/utils'

interface PartyBadgeProps {
  party: string
  size?: 'sm' | 'md'
}

export function PartyBadge({ party, size = 'md' }: PartyBadgeProps) {
  const name = PARTY_NAMES[party] ?? party
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm',
      )}
      style={{
        borderColor: PARTY_COLORS[party] ?? 'currentColor',
        color:       PARTY_COLORS[party] ?? 'currentColor',
      }}
    >
      {party} — {name}
    </span>
  )
}
