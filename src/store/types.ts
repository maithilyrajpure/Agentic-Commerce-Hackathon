import type { Mandate, MandateState } from '../domain/mandate.js';

export interface MandateQuery {
  state?: MandateState | MandateState[];
  requesterPhone?: string;
  merchant?: string;
  since?: string;
  limit?: number;
}

/**
 * Persistence boundary. The orchestrator talks only to this interface, so
 * swapping the JSON file for Postgres is one new implementation and one line
 * in store/index.ts. Nothing above this layer knows where bytes live.
 */
export interface MandateRepository {
  create(mandate: Mandate): Promise<Mandate>;
  get(id: string): Promise<Mandate | null>;
  /** Throws NotFoundError instead of returning null. */
  require(id: string): Promise<Mandate>;
  update(mandate: Mandate): Promise<Mandate>;
  list(query?: MandateQuery): Promise<Mandate[]>;
  findBySessionId(sessionId: string): Promise<Mandate | null>;

  /**
   * Serializes read-modify-write on one mandate.
   *
   * Two Prava webhook deliveries for the same session arriving 5ms apart must
   * not both read state=PROVISIONED and both start a checkout. Every mutation
   * in the orchestrator goes through this.
   */
  withLock<T>(id: string, fn: (mandate: Mandate) => Promise<T>): Promise<T>;

  /** Cumulative approved spend for one requester in a calendar month. */
  spendThisMonthCents(requesterPhone: string, now?: Date): Promise<number>;

  /** Active (non-terminal) mandates for a merchant, for duplicate detection. */
  activeForMerchant(merchant: string): Promise<Mandate[]>;

  clear(): Promise<void>;
}
