import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agora',
  description: 'Transparens i svensk politik',
}

// The [locale] layout provides <html> and <body>.
// This root layout is a passthrough required by Next.js.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

