import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../lib/logger.js';
import type { Mandate } from '../domain/mandate.js';
import { InMemoryMandateRepository } from './memory.js';

/**
 * Durable-enough persistence with zero native dependencies: the in-memory map
 * is the working set, and every mutation is flushed to disk atomically.
 *
 * Atomic means write-to-temp then rename. A rename within a filesystem is
 * atomic, so a crash mid-write leaves the previous good file intact rather than
 * a truncated JSON document that fails to parse on the next boot.
 *
 * Writes are coalesced: concurrent mutations share one flush instead of
 * queueing N serial disk writes.
 */
export class JsonFileMandateRepository extends InMemoryMandateRepository {
  private readonly path: string;
  private flushing: Promise<void> | null = null;
  private dirty = false;

  constructor(filePath: string) {
    super();
    this.path = resolve(filePath);
  }

  static async open(filePath: string): Promise<JsonFileMandateRepository> {
    const repo = new JsonFileMandateRepository(filePath);
    await repo.load();
    return repo;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as { mandates?: Mandate[] };
      for (const m of parsed.mandates ?? []) this.mandates.set(m.id, m);
      logger.info({ path: this.path, count: this.mandates.size }, 'mandate store loaded');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        logger.info({ path: this.path }, 'mandate store empty, starting fresh');
        return;
      }
      // A corrupt store should not silently discard history.
      logger.error({ path: this.path, err: err.message }, 'mandate store unreadable');
      throw err;
    }
  }

  protected override async persist(): Promise<void> {
    this.dirty = true;
    if (this.flushing) return this.flushing;

    this.flushing = (async () => {
      // Let synchronous callers in the same tick batch into this flush.
      await Promise.resolve();
      while (this.dirty) {
        this.dirty = false;
        await this.flush();
      }
      this.flushing = null;
    })();

    return this.flushing;
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: 1, savedAt: new Date().toISOString(), mandates: [...this.mandates.values()] },
      null,
      2,
    );
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    } catch (error) {
      logger.error({ path: this.path, err: (error as Error).message }, 'mandate store flush failed');
    }
  }
}
