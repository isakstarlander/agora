import { NextRequest } from 'next/server'
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { apiRoute } from '@/lib/api/handler'
import { paginated } from '@/lib/api/response'
import { parsePagination, paginate } from '@/lib/api/pagination'
import { createClient } from '@/lib/supabase/server'
import { registry } from '@/lib/api/openapi/registry'

extendZodWithOpenApi(z)

const MemberSchema = z.object({
  id:           z.string().openapi({ example: '0980657611616' }),
  first_name:   z.string(),
  last_name:    z.string(),
  party:        z.string().openapi({ example: 'S' }),
  constituency: z.string().nullable(),
  status:       z.string().openapi({ example: 'active' }),
  image_url:    z.string().nullable(),
}).openapi('Member')

registry.registerPath({
  method: 'get',
  path:   '/members',
  summary: 'List members (ledamöter)',
  request: {
    query: z.object({
      party:    z.string().optional().openapi({ description: 'Party code e.g. S, M, SD' }),
      status:   z.enum(['active', 'inactive']).optional(),
      page:     z.coerce.number().optional(),
      per_page: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: { description: 'List of members', content: { 'application/json': { schema: z.object({ data: z.array(MemberSchema) }) } } },
  },
})

export const GET = apiRoute(async (req: NextRequest) => {
  const sp       = req.nextUrl.searchParams
  const pg       = parsePagination(sp)
  const { from, to } = paginate(pg)
  const supabase = await createClient()

  let query = supabase
    .from('members')
    .select('id, first_name, last_name, party, constituency, status, image_url', { count: 'exact' })
    .order('last_name')
    .range(from, to)

  const party  = sp.get('party')
  const status = sp.get('status')
  if (party)  query = query.eq('party', party)
  if (status) query = query.eq('status', status)

  const { data, count, error } = await query
  if (error) throw error

  return paginated(data ?? [], count ?? 0, pg.page, pg.per_page)
})
