import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { registry } from './registry'

// ── /keys/request ────────────────────────────────────────────────────────────
registry.registerPath({
  method:  'post',
  path:    '/keys/request',
  summary: 'Request a free API key',
  description: [
    'Submit your email and a description of your intended use.',
    'Returns a new API key — shown once and never stored in plain text.',
    'Include the key on subsequent requests as: Authorization: Bearer agora_...',
  ].join(' '),
  tags: ['Authentication'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            email:       z.string().email().openapi({ example: 'journalist@dn.se' }),
            description: z.string().min(20).max(500).openapi({
              example: 'Building an election tracker for DN.se readers.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'API key created — store the key field, it is shown only once' },
    400: { description: 'Validation error or key limit reached' },
  },
})

export function generateOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title:       'Agora API',
      description: 'Swedish political data API — motioner, ledamöter, voteringar, budget, valmanifest',
      version:     '1.0.0',
      contact:     { url: 'https://agora.se' },
      license:     { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    },
    servers: [{ url: 'https://agora.se/api/v1' }],
  })
}
