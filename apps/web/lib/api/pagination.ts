import { z } from 'zod'

export const PaginationSchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
})

export type PaginationParams = z.infer<typeof PaginationSchema>

export function paginate(params: PaginationParams) {
  const from = (params.page - 1) * params.per_page
  const to   = from + params.per_page - 1
  return { from, to }
}

export function parsePagination(searchParams: URLSearchParams): PaginationParams {
  const result = PaginationSchema.safeParse({
    page:     searchParams.get('page'),
    per_page: searchParams.get('per_page'),
  })
  return result.success ? result.data : { page: 1, per_page: 20 }
}
