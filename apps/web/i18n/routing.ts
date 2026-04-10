import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['sv', 'en'] as const,
  defaultLocale: 'sv',
})
