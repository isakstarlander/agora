'use client'

import { useState, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Key, Loader2, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { requestApiKey } from '@/lib/actions/request-key'

export function RequestKeyPanel() {
  const [open, setOpen]              = useState(false)
  const [email, setEmail]            = useState('')
  const [desc, setDesc]              = useState('')
  const [result, setResult]          = useState<{ key?: string; prefix?: string; error?: string } | null>(null)
  const [copied, setCopied]          = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleCopy() {
    if (result?.key) {
      navigator.clipboard.writeText(result.key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const res = await requestApiKey(email, desc)
      setResult(res)
    })
  }

  return (
    <Card className="border-dashed">
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Key className="h-4 w-4" />
            Använd API:et i ditt eget projekt
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </CardTitle>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4">
          {!result?.key ? (
            <>
              <p className="text-xs text-muted-foreground">
                Begär en kostnadsfri API-nyckel. Du får direkt åtkomst till samma
                endpoints som den här demon använder — inklusive accountability-frågor.
              </p>

              <form onSubmit={handleSubmit} className="space-y-3">
                <Input
                  type="email"
                  placeholder="Din e-postadress"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
                <Textarea
                  placeholder="Beskriv hur du tänker använda API:et (minst 20 tecken)…"
                  value={desc}
                  onChange={e => setDesc(e.target.value)}
                  rows={3}
                  minLength={20}
                  required
                />
                {result?.error && (
                  <p className="text-xs text-destructive">{result.error}</p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={isPending || !email || desc.length < 20}
                  className="w-full"
                >
                  {isPending && <Loader2 className="h-3 w-3 animate-spin mr-2" />}
                  Begär API-nyckel
                </Button>
              </form>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Din nyckel är skapad. Spara den nu — den visas aldrig igen.
              </p>

              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted px-3 py-2 rounded font-mono break-all">
                  {result.key}
                </code>
                <Button variant="outline" size="icon" onClick={handleCopy} className="shrink-0">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              <div className="space-y-1 text-xs text-muted-foreground">
                <p>Prefix: <code className="font-mono">{result.prefix}</code></p>
                <p>Inkludera nyckeln i varje anrop:</p>
                <code className="block bg-muted px-3 py-2 rounded font-mono text-xs break-all">
                  {`Authorization: Bearer ${result.key}`}
                </code>
              </div>

              <a
                href="/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center h-7 px-2.5 rounded-lg text-[0.8rem] border border-border bg-background hover:bg-muted hover:text-foreground"
              >
                Läs API-dokumentationen
              </a>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
