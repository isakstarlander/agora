import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

// Singleton registry — every route module registers its schemas here at import time
export const registry = new OpenAPIRegistry()
