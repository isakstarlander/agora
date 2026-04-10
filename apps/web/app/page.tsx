import { redirect } from 'next/navigation'

// Fallback redirect — the proxy handles locale routing for all paths,
// but this covers any edge case where proxy is bypassed.
export default function RootPage() {
  redirect('/sv')
}

