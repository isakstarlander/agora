export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export class NotFoundError extends ApiRequestError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, 404)
  }
}

export class ValidationError extends ApiRequestError {
  constructor(message: string) {
    super('BAD_REQUEST', message, 400)
  }
}
