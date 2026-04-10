import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'

// Singleton registry — every route module registers its schemas here at import time
export const registry = new OpenAPIRegistry()
