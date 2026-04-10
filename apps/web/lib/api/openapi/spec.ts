import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { registry } from './registry'

// ── Security schemes ──────────────────────────────────────────────────────
registry.registerComponent('securitySchemes', 'BearerAuth', {
  type:         'http',
  scheme:       'bearer',
  bearerFormat: 'agora_<token>',
  description:  'API key issued via POST /api/v1/keys/request',
})

// ── Shared schemas ─────────────────────────────────────────────────────────
// Note: registry.register() requires extendZodWithOpenApi which conflicts with
// Zod v4. Shared schemas are omitted; path descriptions cover the contract.

// ── /members ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/members',
  summary: 'List members (ledamöter)',
  tags: ['Members'],
  request: { query: z.object({
    party:    z.string().optional().openapi({ description: 'Party code: S | M | SD | C | V | KD | L | MP' }),
    status:   z.enum(['active', 'inactive']).optional(),
    page:     z.coerce.number().optional().openapi({ description: 'Page number (default: 1)' }),
    per_page: z.coerce.number().optional().openapi({ description: 'Items per page (max: 100)' }),
  }) },
  responses: { 200: { description: 'List of members' } },
})

registry.registerPath({
  method: 'get', path: '/members/{id}',
  summary: 'Get member by ID',
  tags: ['Members'],
  request: { params: z.object({ id: z.string().openapi({ example: '0980657611616' }) }) },
  responses: {
    200: { description: 'Member profile' },
    404: { description: 'Not found' },
  },
})

registry.registerPath({
  method: 'get', path: '/members/{id}/votes',
  summary: "Member's voting record",
  tags: ['Members'],
  request: {
    params: z.object({ id: z.string() }),
    query:  z.object({ page: z.coerce.number().optional(), per_page: z.coerce.number().optional() }),
  },
  responses: { 200: { description: 'Paginated vote results' } },
})

registry.registerPath({
  method: 'get', path: '/members/{id}/documents',
  summary: 'Documents authored by member',
  tags: ['Members'],
  request: { params: z.object({ id: z.string() }), query: z.object({ page: z.coerce.number().optional() }) },
  responses: { 200: { description: 'Paginated document list' } },
})

// ── /documents ────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/documents',
  summary: 'List parliamentary documents',
  tags: ['Documents'],
  request: { query: z.object({
    type:      z.enum(['mot', 'prop', 'bet', 'ip', 'fr', 'prot', 'SFS']).optional().openapi({ description: 'Document type' }),
    rm:        z.string().optional().openapi({ description: 'Riksmöte e.g. 2024/25' }),
    committee: z.string().optional().openapi({ description: 'Utskott code e.g. FiU' }),
    party:     z.string().optional().openapi({ description: 'Filter by author party' }),
    page:      z.coerce.number().optional(),
    per_page:  z.coerce.number().optional(),
  }) },
  responses: { 200: { description: 'Paginated document list' } },
})

registry.registerPath({
  method: 'get', path: '/documents/{id}',
  summary: 'Get document with full text and authors',
  tags: ['Documents'],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'Full document' }, 404: { description: 'Not found' } },
})

// ── /votes ────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/votes',
  summary: 'List votes (voteringar)',
  tags: ['Votes'],
  request: { query: z.object({
    rm:       z.string().optional(),
    page:     z.coerce.number().optional(),
    per_page: z.coerce.number().optional(),
  }) },
  responses: { 200: { description: 'Paginated vote list' } },
})

registry.registerPath({
  method: 'get', path: '/votes/{id}',
  summary: 'Get vote with party breakdown',
  tags: ['Votes'],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'Vote detail with results_by_party' }, 404: { description: 'Not found' } },
})

// ── /budget ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/budget',
  summary: 'ESV budget outcomes',
  tags: ['Budget'],
  request: { query: z.object({
    year:                  z.coerce.number().optional().openapi({ description: 'Calendar year e.g. 2024' }),
    expenditure_area_code: z.string().optional().openapi({ description: '2-digit area code e.g. 16' }),
    budget_type:           z.enum(['utfall', 'budget']).optional(),
    page:                  z.coerce.number().optional(),
    per_page:              z.coerce.number().optional(),
  }) },
  responses: { 200: { description: 'Budget outcome rows' } },
})

registry.registerPath({
  method: 'get', path: '/budget/areas',
  summary: 'List all expenditure areas (utgiftsområden)',
  tags: ['Budget'],
  responses: { 200: { description: 'Array of { code, name }' } },
})

// ── /parties ──────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/parties',
  summary: 'List all parties with colors',
  tags: ['Parties'],
  responses: { 200: { description: 'Party list' } },
})

registry.registerPath({
  method: 'get', path: '/parties/{party}/votes',
  summary: "Party's voting record aggregated by vote",
  tags: ['Parties'],
  request: { params: z.object({ party: z.string().openapi({ example: 'S' }) }) },
  responses: { 200: { description: 'Paginated votes with party majority position' } },
})

// ── /search ───────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'get', path: '/search',
  summary: 'Hybrid full-text + semantic document search',
  tags: ['Search'],
  request: { query: z.object({
    q:     z.string().openapi({ description: 'Search query (min 2 chars)' }),
    type:  z.string().optional(),
    rm:    z.string().optional(),
    limit: z.coerce.number().optional().openapi({ description: 'Max results (default 10, max 50)' }),
  }) },
  responses: { 200: { description: 'Ranked document results with fts_rank and vec_rank' } },
})

registry.registerPath({
  method: 'get', path: '/search/manifesto',
  summary: 'Semantic search across party manifestos',
  tags: ['Search'],
  request: { query: z.object({
    q:             z.string(),
    party:         z.string().optional(),
    election_year: z.coerce.number().optional(),
    limit:         z.coerce.number().optional(),
  }) },
  responses: { 200: { description: 'Manifesto statements ranked by semantic similarity' } },
})

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

// ── /accountability ───────────────────────────────────────────────────────────
registry.registerPath({
  method:  'get',
  path:    '/accountability',
  summary: 'Cross-source accountability arc for a party and topic',
  description: [
    'Returns the complete accountability arc across four data layers:',
    'manifesto promises, legislation filed, voting record, and budget outcomes.',
    'Also includes a ≤150-word Swedish synthesis generated by Claude Sonnet.',
    'Requires a valid API key (Authorization: Bearer agora_...).',
  ].join(' '),
  tags: ['Accountability'],
  security: [{ BearerAuth: [] }],
  request: {
    query: z.object({
      party: z.string().min(1).max(4).openapi({ example: 'S', description: 'Party code (S, M, SD, C, V, KD, L, MP)' }),
      topic: z.string().min(3).max(200).openapi({ example: 'klimat', description: 'Topic to analyse (Swedish free text)' }),
    }),
  },
  responses: {
    200: { description: 'Accountability data with all four layers and optional AI summary' },
    400: { description: 'Unknown party code or invalid params' },
    401: { description: 'Missing or invalid API key' },
    403: { description: 'API key revoked' },
    429: { description: 'Rate limit exceeded' },
  },
})

// ── /parties/{party}/alignment ────────────────────────────────────────────────
registry.registerPath({
  method:  'get',
  path:    '/parties/{party}/alignment',
  summary: 'Manifesto position breakdown by Manifesto Project category',
  description: [
    'Returns aggregated manifesto positions for the most recent election year,',
    'grouped by Manifesto Project category code. No API key required.',
  ].join(' '),
  tags: ['Parties'],
  request: {
    params: z.object({
      party: z.string().openapi({ example: 'MP', description: 'Party code' }),
    }),
  },
  responses: {
    200: { description: 'Category breakdown with mean_position per category' },
    404: { description: 'Unknown party code' },
  },
})

export function generateOpenApiSpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title:       'Agora API',
      description: 'Swedish political data API — motioner, ledamöter, voteringar, statsbudget och valmanifest. All data is sourced from Swedish open government APIs under offentlighetsprincipen.',
      version:     '1.0.0',
      contact:     { url: 'https://github.com/isakstarlander/agora' },
      license:     { name: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    },
    servers: [{ url: '/api/v1', description: 'Production' }],
  })
}
