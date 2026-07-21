/** Standalone index rebuild — recomputes baskets + index_values from the
 *  EXISTING oracle_prices (fast; no oracle recompute). Run after changing
 *  index rules, guarded like any writer. */
import { openDb } from './db.js';
import { refreshIndexes } from './indexes.js';
console.log('[indexes:refresh]', JSON.stringify(refreshIndexes(openDb())));
