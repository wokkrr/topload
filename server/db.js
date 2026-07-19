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
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}
