import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { InMemoryMandateRepository } from './memory.js';
import { JsonFileMandateRepository } from './jsonFile.js';
import type { MandateRepository } from './types.js';

export type { MandateRepository, MandateQuery } from './types.js';
export { InMemoryMandateRepository } from './memory.js';
export { JsonFileMandateRepository } from './jsonFile.js';

let singleton: MandateRepository | null = null;

/**
 * Swap point for persistence. To move to Postgres, implement
 * MandateRepository against your driver and add a case here — nothing above
 * the store layer changes.
 */
export async function getRepository(): Promise<MandateRepository> {
  if (singleton) return singleton;

  if (env.STORE_DRIVER === 'memory') {
    logger.info('using in-memory mandate store (state is lost on restart)');
    singleton = new InMemoryMandateRepository();
  } else {
    singleton = await JsonFileMandateRepository.open(env.STORE_FILE_PATH);
  }
  return singleton;
}

/** Test seam. */
export function setRepository(repo: MandateRepository | null): void {
  singleton = repo;
}
