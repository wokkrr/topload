import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) the Topload database and apply the schema.
 * @param {string} [path] file path or ':memory:' for tests
 */
export function openDb(path = join(__dirname, '..', 'data', 'topload.db')) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // Multiple indexers/backfills may run concurrently — queue for the write
  // lock (up to 60s) instead of failing instantly with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 60000;');
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed. */
function migrate(db) {
  ensureColumn(db, 'external_marks', 'sales_volume', 'INTEGER');
  ensureColumn(db, 'oracle_prices', 'source', 'TEXT');
  ensureColumn(db, 'cards', 'image', 'TEXT');
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
