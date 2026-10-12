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
  MS_PER_DAY,
  MS_PER_HOUR,
  SYNC_SOURCES,
  SYNC_TABLES,
  TIDE_STALE_HOURS,
  type SyncTable,
} from '@clearwater/shared';

/** Cursor keys: the feed sources plus the user's own votes (ping_votes where voter_id = me). */
export type CursorKey = SyncTable | 'my_votes';
export type SyncCursors = Partial<Record<CursorKey, string>>;
/** Keyset tie-break value of the last row pulled, per source. */
export type TieKeys = Partial<Record<CursorKey, string>>;

const ms = (iso: string | undefined | null): number => (iso ? Date.parse(iso) : Number.NaN);

export interface PullSpec {
  table: CursorKey;
  /** Extra equality filter (own votes: voter_id = auth.uid()). */
  eq?: { column: string; value: string };
  /** Relation to read (a feed view for pings/votes). */
  relation: string;
  /** Column used as this table's cursor and ordering. */
  cursorColumn: string;
  /** Keyset tie-breaker column. */
  tieColumn: string;
  /** Inclusive lower bound; null = first sync (the caller applies its window). */
  gte: string | null;
}

export function pullSpecs(cursors: SyncCursors): PullSpec[] {
  return SYNC_TABLES.map((table) => ({
    table,
    relation: SYNC_SOURCES[table].relation,
    cursorColumn: SYNC_SOURCES[table].cursorColumn,
    tieColumn: SYNC_SOURCES[table].tieColumn,
    gte: cursors[table] ?? null,
  }));
}

// --- Staleness ---------------------------------------------------------------------------------

/** Tide JSON is refreshed when absent or older than 24 h. */
export function isTideStale(fetchedAt: string | null | undefined, nowMs: number): boolean {
  const t = ms(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > TIDE_STALE_HOURS * MS_PER_HOUR;
}

export type Staleness = 'fresh' | 'yellow' | 'red';

/** AOI older than 14 days: yellow; older than 60 days: red. Unknown download date counts as red. */
export function aoiStaleness(downloadedAt: string | null | undefined, nowMs: number): Staleness {
  const t = ms(downloadedAt);
  if (!Number.isFinite(t)) return 'red';
  const ageDays = (nowMs - t) / MS_PER_DAY;
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
  const ageDays = Math.floor((nowMs - t) / MS_PER_DAY);
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
