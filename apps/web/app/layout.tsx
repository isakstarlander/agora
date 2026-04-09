import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Agora',
  description: 'Transparens i svensk politik',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  )
}
