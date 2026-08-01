/** Typed errors so the API layer can map failures to status codes without string matching. */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(message, 'validation_error', 400, detail);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Signature verification failed') {
    super(message, 'unauthorized', 401);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, 'not_found', 404, { resource, id });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(message, 'conflict', 409, detail);
  }
}

export class UpstreamError extends AppError {
  constructor(
    public readonly service: string,
    message: string,
    detail?: unknown,
  ) {
    super(`${service}: ${message}`, 'upstream_error', 502, detail);
  }
}

export class PolicyViolationError extends AppError {
  constructor(
    message: string,
    public readonly reasons: string[],
  ) {
    super(message, 'policy_violation', 422, { reasons });
  }
}
