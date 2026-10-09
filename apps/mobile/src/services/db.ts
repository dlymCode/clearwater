/**
 * Private on-device store: expo-sqlite built with SQLCipher (app.config.ts plugin `useSQLCipher`).
 * The key is a random 256-bit value kept in the iOS Keychain (expo-secure-store, WHEN_UNLOCKED_THIS_DEVICE_ONLY).
 * Holds: raw soundings (never uploaded), outbox, local ping/vote/message caches, cursors, settings.
 */
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

const KEY_NAME = 'clearwater.db.key.v1';
const DB_NAME = 'clearwater-private.db';

async function getOrCreateKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes); // polyfilled by react-native-get-random-values (index.ts)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(KEY_NAME, hex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return hex;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT,
  bytes INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_status_kind_seq ON outbox (status, kind, seq);
-- Raw soundings: PRIVATE TIER, never uploaded. Only per-cell/day aggregates leave the device.
CREATE TABLE IF NOT EXISTS soundings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, t_ms INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  raw_ft REAL NOT NULL, mllw_depth_ft REAL NOT NULL, tide_ft REAL NOT NULL, station_id TEXT NOT NULL,
  aggregated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS soundings_pending ON soundings (aggregated, t_ms);
CREATE TABLE IF NOT EXISTS pings (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS ping_votes (ping_id TEXT NOT NULL, voter_id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (ping_id, voter_id));
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_group ON messages (group_id, created_at);
`;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    const key = await getOrCreateKey();
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await db.execAsync(SCHEMA);
    return db;
  })();
  return dbPromise;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', key);
  return row ? (JSON.parse(row.v) as T) : null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, JSON.stringify(value));
}
