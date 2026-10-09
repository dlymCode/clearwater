/**
 * Constants mirrored from docs/AGENT-PLAN.md ("Shared contracts — exact values").
 * If a value here disagrees with AGENT-PLAN.md or the PRD, the docs win — fix this file.
 */

// ---------------------------------------------------------------------------
// Ping types (Postgres enum, exact strings)
// ---------------------------------------------------------------------------
export const PING_TYPES = [
  'bar_moved',
  'touched_bottom',
  'log',
  'gear',
  'closure_line',
  'other',
] as const;
export type PingType = (typeof PING_TYPES)[number];

/** Human labels shown on the two-tap ping sheet (FLT-1). */
export const PING_TYPE_LABELS: Readonly<Record<PingType, string>> = {
  bar_moved: 'Bar moved',
  touched_bottom: 'Touched bottom',
  log: 'Log / deadhead',
  gear: 'Gear in channel',
  closure_line: 'Closure line',
  other: 'Other',
};

export function isPingType(value: unknown): value is PingType {
  return typeof value === 'string' && (PING_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Geodesy / rendering
// ---------------------------------------------------------------------------
/** Depth color ramp breakpoints, feet MLLW (MAP-2). Identical online and offline. */
export const DEPTH_COLOR_RAMP_FT = [0, 3, 6, 10, 20, 40] as const;

/** H3 resolution for depth aggregation (~8 m edge). */
export const H3_RESOLUTION = 12;

export const WORKING_EPSG = 32610;
export const TILE_EPSG = 3857;

export const FEET_PER_METER = 3.280839895013123;
export const METERS_PER_FOOT = 0.3048;
export const FEET_PER_FATHOM = 6;
export const KMH_PER_KNOT = 1.852;

/** Canonical AOI slugs (paths, Makefile targets, tiles index). */
export const AOI_SLUGS = ['skagit', 'port_susan', 'snohomish', 'padilla_samish', 'nisqually'] as const;
export type AoiSlug = (typeof AOI_SLUGS)[number];

export const AOI_LABELS: Readonly<Record<AoiSlug, string>> = {
  skagit: 'Skagit Bay and flats',
  port_susan: 'Port Susan and the Stillaguamish',
  snohomish: 'Snohomish delta',
  padilla_samish: 'Padilla and Samish Bay',
  nisqually: 'Nisqually delta',
};

/** Tile zoom ranges per layer (EPSG:3857). */
export const TILE_ZOOM = {
  base: { min: 8, max: 16 },
  depth: { min: 8, max: 16 },
  waterline: { min: 10, max: 16 },
  fleet: { min: 10, max: 16 },
} as const;

/** Layers in a tiles/index.json AOI entry. */
export const TILE_LAYERS = ['base', 'depth', 'waterline', 'fleet'] as const;
export type TileLayer = (typeof TILE_LAYERS)[number];

// ---------------------------------------------------------------------------
// Ping score (must be identical in SQL and TS)
//   S = R_a * (1 + sum_i R_i * v_i * w(d_i)) * exp(-lambda * (t_now - t_last))
// ---------------------------------------------------------------------------
/** Half-life of an unconfirmed ping, hours. */
export const PING_HALF_LIFE_HOURS = 24;
/** lambda = ln(2) / 24 h, expressed per hour. t is always measured in hours. */
export const SCORE_LAMBDA_PER_HOUR = Math.LN2 / PING_HALF_LIFE_HOURS;
/** Same lambda per second, exactly as supabase score_ping computes it (ln(2) / 86400). Use this for digit-for-digit parity. */
export const SCORE_LAMBDA_PER_SECOND = Math.LN2 / 86400.0;

/** Distance weight w(d) steps (voter's last position vs. the ping). */
export const VOTE_WEIGHT_NEAR_M = 200;
export const VOTE_WEIGHT_FAR_M = 500;
export const VOTE_WEIGHT_NEAR = 1.0;
export const VOTE_WEIGHT_FAR = 0.5;
/** A confirm needs the voter within 500 m of the ping in the last 24 h (FLT-2). */
export const CONFIRM_ELIGIBILITY_M = 500;
export const CONFIRM_ELIGIBILITY_WINDOW_HOURS = 24;

/** Render thresholds: S < 0.25 hidden; < 0.5 faded; <= 1.5 normal; > 1.5 solid. */
export const SCORE_HIDDEN_BELOW = 0.25;
export const SCORE_FADED_BELOW = 0.5;
export const SCORE_SOLID_ABOVE = 1.5;

/** Reputation (server weekly batch; mirrored for display only). */
export const REPUTATION_DEFAULT = 1.0;
export const REPUTATION_MIN = 0.2;
export const REPUTATION_MAX = 3.0;
export const REPUTATION_PUBLIC_HIDE_BELOW = 0.3;

// ---------------------------------------------------------------------------
// Depth logging
// ---------------------------------------------------------------------------
export const DEPTH_FILTER = {
  /** Drop when SOG < 0.5 kt (aerated transducer) or > 25 kt. */
  MIN_SOG_KT: 0.5,
  MAX_SOG_KT: 25,
  /** Drop when |delta depth| exceeds this many feet within 1 s. */
  MAX_JUMP_FT_PER_S: 10,
  /** Drop when GPS HDOP exceeds this. */
  MAX_HDOP: 5,
} as const;

/** Fleet layer: cell published only with >= 3 distinct boats; app hatches below 3 (FLT-6). */
export const FLEET_MIN_BOATS = 3;
/** Waterline DEM: cell hatched below 5 scenes (MAP-4). */
export const WATERLINE_MIN_SCENES = 5;
/** Waterline DEM: cells with bracket > 3 ft are masked by the pipeline. */
export const WATERLINE_MAX_BRACKET_FT = 3;

// ---------------------------------------------------------------------------
// Rate limits (backend edge function; mirrored so the client can pre-empt)
// ---------------------------------------------------------------------------
export const RATE_LIMITS = {
  PINGS_PER_HOUR: 30,
  VOTES_PER_HOUR: 60,
  MESSAGES_PER_MINUTE: 10,
  /** One depth upload batch per 15 minutes per user. */
  DEPTH_BATCH_INTERVAL_MIN: 15,
} as const;

// ---------------------------------------------------------------------------
// Field limits (also Postgres check constraints)
// ---------------------------------------------------------------------------
export const PING_NOTE_MAX = 140;
export const MESSAGE_BODY_MAX = 500;
export const INVITE_CODE_LENGTH = 8;
export const INVITE_TTL_DAYS = 7;
export const MESSAGE_RETENTION_DAYS = 90;
/** Pings visible 48 h (decay hides sooner via score). */
export const PING_VISIBLE_HOURS = 48;

// ---------------------------------------------------------------------------
// Offline / sync
// ---------------------------------------------------------------------------
export const GPS_STALE_MS = 5_000;
export const AOI_STALE_YELLOW_DAYS = 14;
export const AOI_STALE_RED_DAYS = 60;
export const TIDE_STALE_HOURS = 24;
export const TIDE_PREDICTION_DAYS_AHEAD = 30;
export const TIDE_CURVE_WINDOW_HOURS = 48;
export const OUTBOX_CAP_BYTES = 50 * 1024 * 1024;
export const SYNC_BACKGROUND_INTERVAL_MIN = 15;
/** Server rejects timestamps more than 7 days in the future. */
export const MAX_FUTURE_SKEW_DAYS = 7;

/** Last-known position reporter: rounded to 100 m, at most every 5 min, foreground only. */
export const LAST_POSITION = {
  ROUND_M: 100,
  MIN_INTERVAL_MS: 5 * 60 * 1000,
} as const;

/** Outbox kinds, in dependency (send) order: votes reference pings; messages may reference pings. */
export const OUTBOX_KINDS = ['ping', 'vote', 'message', 'depth_batch'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** Server tables pulled by the inbound cursor sync. */
export const SYNC_TABLES = ['pings', 'ping_votes', 'messages'] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * Where each inbound table is read from and which column is its sync cursor. Not every table has
 * `updated_at`: votes are immutable (server created_at), messages use the server clock (received_at).
 * Pings and votes are read through the feed views, which expose reputations for client-side scoring and
 * hide the author of anonymous pings.
 */
export const SYNC_SOURCES = {
  pings: { relation: 'ping_feed', cursorColumn: 'updated_at' },
  ping_votes: { relation: 'ping_votes_feed', cursorColumn: 'created_at' },
  messages: { relation: 'messages', cursorColumn: 'received_at' },
} as const satisfies Record<SyncTable, { relation: string; cursorColumn: string }>;

/** Server accepts at most this many rows per depth upload batch. */
export const DEPTH_BATCH_MAX_ROWS = 5000;
