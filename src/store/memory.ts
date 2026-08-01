import { NotFoundError } from '../domain/errors.js';
import { isTerminal, type Mandate } from '../domain/mandate.js';
import type { MandateQuery, MandateRepository } from './types.js';

/** Deep clone on read/write so callers cannot mutate stored state by reference. */
const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryMandateRepository implements MandateRepository {
  protected readonly mandates = new Map<string, Mandate>();
  private readonly locks = new Map<string, Promise<unknown>>();

  protected async persist(): Promise<void> {
    /* no-op for the in-memory driver */
  }

  async create(mandate: Mandate): Promise<Mandate> {
    this.mandates.set(mandate.id, clone(mandate));
    await this.persist();
    return clone(mandate);
  }

  async get(id: string): Promise<Mandate | null> {
    const found = this.mandates.get(id);
    return found ? clone(found) : null;
  }

  async require(id: string): Promise<Mandate> {
    const found = await this.get(id);
    if (!found) throw new NotFoundError('Mandate', id);
    return found;
  }

  async update(mandate: Mandate): Promise<Mandate> {
    if (!this.mandates.has(mandate.id)) throw new NotFoundError('Mandate', mandate.id);
    this.mandates.set(mandate.id, clone(mandate));
    await this.persist();
    return clone(mandate);
  }

  async list(query: MandateQuery = {}): Promise<Mandate[]> {
    const states = query.state ? (Array.isArray(query.state) ? query.state : [query.state]) : null;
    let rows = [...this.mandates.values()];

    if (states) rows = rows.filter((m) => states.includes(m.state));
    if (query.requesterPhone) rows = rows.filter((m) => m.requesterPhone === query.requesterPhone);
    if (query.merchant) {
      const needle = query.merchant.toLowerCase();
      rows = rows.filter((m) => m.scope.merchant.toLowerCase() === needle);
    }
    if (query.since) {
      const cutoff = new Date(query.since).getTime();
      rows = rows.filter((m) => new Date(m.createdAt).getTime() >= cutoff);
    }

    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (query.limit) rows = rows.slice(0, query.limit);
    return rows.map(clone);
  }

  async findBySessionId(sessionId: string): Promise<Mandate | null> {
    for (const m of this.mandates.values()) {
      if (m.prava.sessionId === sessionId) return clone(m);
    }
    return null;
  }

  /**
   * Promise-chain mutex keyed by mandate id. Each caller appends to the tail of
   * that mandate's chain, so critical sections run in strict arrival order.
   * The tail is always a settled-swallowing promise, so a throw inside one
   * critical section cannot poison the next one.
   */
  async withLock<T>(id: string, fn: (mandate: Mandate) => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();

    const run = previous.then(async () => {
      const mandate = await this.require(id);
      const result = await fn(mandate);
      await this.update(mandate);
      return result;
    });

    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, tail);

    // Drop the entry once this is the last waiter, so the map does not grow
    // without bound over a long-running process.
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });

    return run;
  }

  async spendThisMonthCents(requesterPhone: string, now: Date = new Date()): Promise<number> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
    let total = 0;
    for (const m of this.mandates.values()) {
      if (m.requesterPhone !== requesterPhone) continue;
      if (new Date(m.createdAt).getTime() < monthStart) continue;
      // Count anything that reached (or passed) authorization: committed budget.
      if (['AUTHORIZED', 'PROVISIONED', 'EXECUTING', 'COMPLETED'].includes(m.state)) {
        total += m.amountCents;
      }
    }
    return total;
  }

  async activeForMerchant(merchant: string): Promise<Mandate[]> {
    const needle = merchant.trim().toLowerCase();
    return [...this.mandates.values()]
      .filter((m) => m.scope.merchant.trim().toLowerCase() === needle && !isTerminal(m.state))
      .map(clone);
  }

  async clear(): Promise<void> {
    this.mandates.clear();
    await this.persist();
  }
}
