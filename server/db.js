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
  // No mmap: concurrent processes checkpointing/truncating the WAL can SIGBUS
  // a memory-mapped reader (observed as 'zsh: bus error' during parallel
  // backfills). Plain read syscalls are immune and barely slower here.
  db.exec('PRAGMA mmap_size = 0;');
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed. */
function migrate(db) {
  ensureColumn(db, 'external_marks', 'sales_volume', 'INTEGER');
  ensureColumn(db, 'oracle_prices', 'source', 'TEXT');
  ensureColumn(db, 'cards', 'image', 'TEXT');
  // Language of the printing ('English', 'Japanese', …). Cards always carry an
  // ENGLISH/romanized name for display + matching; this tags the printing so
  // the UI can show "· Japanese" without the user ever reading kanji.
  ensureColumn(db, 'cards', 'language', "TEXT NOT NULL DEFAULT 'English'");
  ensureColumn(db, 'gacha_listings', 'image_back', 'TEXT');
  ensureColumn(db, 'gacha_listings', 'proof', 'TEXT'); // courtyard asset-page hash
  // Grading-slab certification number (verifiable on the grader's site).
  // Sources: Courtyard 'Serial' attribute; MNSTR serialNumber. Never guessed.
  ensureColumn(db, 'gacha_listings', 'cert', 'TEXT');
}

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
