'use server'

export interface RequestKeyResult {
  key?:    string
  prefix?: string
  error?:  string
}

export async function requestApiKey(
  email: string,
  description: string,
): Promise<RequestKeyResult> {
  if (!email || !description || description.length < 20) {
    return { error: 'Beskriv din användning i minst 20 tecken.' }
  }

  try {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res  = await fetch(`${base}/api/v1/keys/request`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, description }),
    })
    const json = await res.json()

    if (!res.ok) {
      return { error: json.error?.message ?? 'Något gick fel.' }
    }

    return { key: json.data.key, prefix: json.data.prefix }
  } catch {
    return { error: 'Kunde inte nå API:et. Försök igen.' }
  }
}
