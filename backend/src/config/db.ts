import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR  = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'chikko-share.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

export const db = new Database(DB_PATH);

// ── Pragma for performance ─────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema migration ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS transfers (
    id             TEXT    PRIMARY KEY,
    room_id        TEXT    NOT NULL,
    filename       TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    bucket_key     TEXT    NOT NULL,
    status         TEXT    NOT NULL DEFAULT 'uploading',
    expires_at     INTEGER NOT NULL,
    download_token TEXT    UNIQUE NOT NULL,
    network_mode   TEXT    NOT NULL DEFAULT 'cloud',
    created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    downloaded_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_transfers_token   ON transfers(download_token);
  CREATE INDEX IF NOT EXISTS idx_transfers_room    ON transfers(room_id);
  CREATE INDEX IF NOT EXISTS idx_transfers_expires ON transfers(expires_at);
`);

// ── Simple Migrations ──────────────────────────────────────────────────────────
try { db.exec("ALTER TABLE transfers ADD COLUMN upload_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE transfers ADD COLUMN checksum TEXT"); } catch (e) {}

console.log('[DB] SQLite ready at', DB_PATH);
