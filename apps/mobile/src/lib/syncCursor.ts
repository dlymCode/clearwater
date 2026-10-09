/**
 * Inbound sync logic (PRD §Inbound sync). On connect: pull pings/votes/messages updated since the
 * per-table cursor (server `updated_at`), pull the tiles index, pull tide JSON older than 24 h.
 *
 * Cursor rules:
 *  - cursors are server timestamps (never the device clock), kept per table, and only ever advance;
 *  - pulls are INCLUSIVE (updated_at >= cursor) and the caller upserts by primary key, so rows sharing
 *    the cursor's exact timestamp at a page boundary are never skipped;
 *  - realtime is additive and never advances a cursor.
 */
import {
  AOI_STALE_RED_DAYS,
  AOI_STALE_YELLOW_DAYS,
  SYNC_TABLES,
  TIDE_STALE_HOURS,
  type SyncTable,
} from '@clearwater/shared';

export type SyncCursors = Partial<Record<SyncTable, string>>;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : Number.NaN);

/** New cursor = max(previous, newest updated_at in `rows`). Never moves backwards; ignores bad stamps. */
export function advanceCursor(
  previous: string | undefined,
  rows: ReadonlyArray<{ updated_at?: string | null }>,
): string | undefined {
  let best = previous;
  let bestMs = ms(previous);
  for (const r of rows) {
    const t = ms(r.updated_at);
    if (Number.isFinite(t) && (!Number.isFinite(bestMs) || t > bestMs)) {
      best = r.updated_at as string;
      bestMs = t;
    }
  }
  return best;
}

export interface PullSpec {
  table: SyncTable;
  /** Inclusive lower bound on updated_at; null = first sync (pull the last-48 h window instead). */
  updatedAtGte: string | null;
}

export function pullSpecs(cursors: SyncCursors): PullSpec[] {
  return SYNC_TABLES.map((table) => ({ table, updatedAtGte: cursors[table] ?? null }));
}

/** Keep the latest version of each id (rows from an inclusive pull overlap by design). */
export function dedupeById<T extends { id?: string; updated_at?: string | null }>(rows: readonly T[]): T[] {
  const m = new Map<string, T>();
  const noId: T[] = [];
  for (const r of rows) {
    if (!r.id) {
      noId.push(r);
      continue;
    }
    const prev = m.get(r.id);
    if (!prev || !(ms(prev.updated_at) > ms(r.updated_at))) m.set(r.id, r);
  }
  return [...m.values(), ...noId];
}

// --- Staleness ---------------------------------------------------------------------------------

/** Tide JSON is refreshed when absent or older than 24 h. */
export function isTideStale(fetchedAt: string | null | undefined, nowMs: number): boolean {
  const t = ms(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > TIDE_STALE_HOURS * HOUR_MS;
}

export type Staleness = 'fresh' | 'yellow' | 'red';

/** AOI older than 14 days: yellow; older than 60 days: red. Unknown download date counts as red. */
export function aoiStaleness(downloadedAt: string | null | undefined, nowMs: number): Staleness {
  const t = ms(downloadedAt);
  if (!Number.isFinite(t)) return 'red';
  const ageDays = (nowMs - t) / DAY_MS;
  if (ageDays > AOI_STALE_RED_DAYS) return 'red';
  if (ageDays > AOI_STALE_YELLOW_DAYS) return 'yellow';
  return 'fresh';
}

export interface StalenessBanner {
  level: 'yellow' | 'red';
  ageDays: number | null;
  message: string;
}

export function aoiBanner(aoiLabel: string, downloadedAt: string | null | undefined, nowMs: number): StalenessBanner | null {
  const level = aoiStaleness(downloadedAt, nowMs);
  if (level === 'fresh') return null;
  const t = ms(downloadedAt);
  if (!Number.isFinite(t)) {
    return { level, ageDays: null, message: `${aoiLabel}: download date unknown. Re-download on WiFi before your run.` };
  }
  const ageDays = Math.floor((nowMs - t) / DAY_MS);
  return {
    level,
    ageDays,
    message:
      level === 'red'
        ? `${aoiLabel} was downloaded ${ageDays} days ago. Depths may be badly out of date; update on WiFi.`
        : `${aoiLabel} was downloaded ${ageDays} days ago. Update on WiFi to get the latest bars.`,
  };
}

// --- Plan --------------------------------------------------------------------------------------

export interface SyncPlanInput {
  cursors: SyncCursors;
  /** station id => ISO time of the last successful tide fetch. */
  tideFetchedAt: Readonly<Record<string, string | null | undefined>>;
  /** Stations needed for the downloaded AOIs and the current position. */
  tideStations: readonly string[];
  nowMs: number;
}

export interface SyncPlan {
  pulls: PullSpec[];
  pullTilesIndex: true;
  tideStationsToRefresh: string[];
}

export function planSync(i: SyncPlanInput): SyncPlan {
  return {
    pulls: pullSpecs(i.cursors),
    pullTilesIndex: true,
    tideStationsToRefresh: i.tideStations.filter((s) => isTideStale(i.tideFetchedAt[s], i.nowMs)),
  };
}
