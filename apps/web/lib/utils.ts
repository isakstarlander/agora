import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const PARTY_COLORS: Record<string, string> = {
  S:  'var(--party-s)',
  M:  'var(--party-m)',
  SD: 'var(--party-sd)',
  C:  'var(--party-c)',
  V:  'var(--party-v)',
  KD: 'var(--party-kd)',
  L:  'var(--party-l)',
  MP: 'var(--party-mp)',
}

export const PARTY_NAMES: Record<string, string> = {
  S:  'Socialdemokraterna',
  M:  'Moderaterna',
  SD: 'Sverigedemokraterna',
  C:  'Centerpartiet',
  V:  'Vänsterpartiet',
  KD: 'Kristdemokraterna',
  L:  'Liberalerna',
  MP: 'Miljöpartiet',
}

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  mot:  'Motion',
  prop: 'Proposition',
  bet:  'Betänkande',
  ip:   'Interpellation',
  fr:   'Skriftlig fråga',
  frs:  'Svar på fråga',
  prot: 'Protokoll',
  SFS:  'Lag (SFS)',
}

/** Current riksmöte as of implementation. Update each September. */
export function getCurrentRm(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  // Riksmöte starts in September
  if (month >= 9) {
    return `${year}/${String(year + 1).slice(2)}`
  }
  return `${year - 1}/${String(year).slice(2)}`
}
