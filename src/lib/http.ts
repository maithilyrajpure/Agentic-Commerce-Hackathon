import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { scrubDeep } from './redact.js';

/**
 * One HTTP policy for every upstream, so retry behaviour is a property of the
 * system rather than a per-file accident.
 *
 * Three things the original code got wrong and this fixes:
 *  1. Retrying non-idempotent POSTs without an idempotency key. Retrying
 *     "create a payment session" after a timeout can mint two sessions and
 *     charge twice. We attach a stable key per logical operation.
 *  2. Retrying 4xx. A 401 will still be a 401 in 500ms; retrying just burns
 *     the rate limit budget. We retry 408/429/5xx and transport errors only.
 *  3. Backoff without jitter, which synchronizes every retrying client into a
 *     thundering herd. We use full jitter.
 */

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400, maxDelayMs: 6_000 };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

export function isRetryable(error: unknown): boolean {
  const err = error as AxiosError;
  if (err?.response) return RETRYABLE_STATUS.has(err.response.status);
  if (err?.code) return RETRYABLE_CODES.has(err.code);
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full jitter: pick uniformly from [0, min(cap, base * 2^attempt)]. */
function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * Trips after repeated failures so a dead upstream fails fast instead of
 * holding request threads open for the full timeout on every call.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.failures = 0; // half-open: let the next call probe.
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures === this.threshold) {
      this.openedAt = Date.now();
      logger.warn({ upstream: this.name, threshold: this.threshold }, 'circuit breaker opened');
    }
  }
}

export interface HttpClientOptions {
  name: string;
  baseURL: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
}

export interface RequestOptions extends AxiosRequestConfig {
  /** Stable across retries of the same logical operation. */
  idempotencyKey?: string;
  /** Override the client-level retry policy for this call. */
  retry?: Partial<RetryPolicy>;
  /** Set false for operations that must never be replayed. */
  retryable?: boolean;
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly retry: RetryPolicy;
  private readonly breaker: CircuitBreaker;
  readonly name: string;

  constructor(opts: HttpClientOptions) {
    this.name = opts.name;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.breaker = new CircuitBreaker(opts.name);
    this.axios = axios.create({
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 15_000,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'mandate-manager/1.0', ...opts.headers },
      validateStatus: (s) => s >= 200 && s < 300,
    });
  }

  async request<T>(config: RequestOptions): Promise<T> {
    if (this.breaker.isOpen) {
      throw new Error(`${this.name} circuit breaker is open; refusing request to ${config.url}`);
    }

    const policy = { ...this.retry, ...config.retry };
    const allowRetry = config.retryable !== false;
    const idempotencyKey = config.idempotencyKey ?? randomUUID();
    const log = logger.child({ upstream: this.name, method: config.method ?? 'GET', path: config.url });

    let lastError: unknown;

    for (let attempt = 0; attempt < policy.attempts; attempt++) {
      try {
        const started = Date.now();
        const res = await this.axios.request<T>({
          ...config,
          headers: {
            ...config.headers,
            'Idempotency-Key': idempotencyKey,
            'X-Request-Id': `${idempotencyKey}-${attempt}`,
          },
        });
        this.breaker.recordSuccess();
        log.debug({ status: res.status, ms: Date.now() - started, attempt: attempt + 1 }, 'upstream ok');
        return res.data;
      } catch (error) {
        lastError = error;
        const err = error as AxiosError;
        const status = err.response?.status;
        const body = scrubDeep(err.response?.data);

        const willRetry = allowRetry && isRetryable(error) && attempt < policy.attempts - 1;
        log[willRetry ? 'warn' : 'error'](
          { status, code: err.code, attempt: attempt + 1, of: policy.attempts, body },
          willRetry ? 'upstream failed, retrying' : 'upstream failed',
        );

        if (!willRetry) break;
        await sleep(backoffDelay(attempt, policy));
      }
    }

    this.breaker.recordFailure();
    throw lastError;
  }

  get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>({ ...options, method: 'GET', url });
  }

  post<T>(url: string, data: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>({ ...options, method: 'POST', url, data });
  }
}

/** Extract a human-usable message from an axios failure without leaking secrets. */
export function describeHttpError(error: unknown): string {
  const err = error as AxiosError<{ message?: string; error?: string; detail?: string }>;
  if (err?.response) {
    const data = err.response.data;
    const msg = data?.message ?? data?.error ?? data?.detail ?? err.response.statusText;
    return `HTTP ${err.response.status} ${msg ?? ''}`.trim();
  }
  if (err?.code) return `${err.code}: ${err.message}`;
  return (error as Error)?.message ?? 'unknown error';
}
