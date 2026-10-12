/**
 * Wire / domain types shared by the mobile app. Column names follow PRD §Data model.
 * Timestamps are ISO-8601 UTC strings unless noted.
 */
import type { PingType, TileLayer } from './constants';

export interface Profile {
  id: string;
  handle: string;
  vessel_name: string | null;
  reputation: number;
  created_at: string;
}

/**
 * Row of `groups` as clients can read it. The invite code is NOT a selectable column; owners read it through the
 * get_invite_code(p_group) RPC and rotate_invite_code returns the new one.
 */
export interface Group {
  id: string;
  name: string;
  owner_id: string;
  invite_expires_at: string | null;
  created_at?: string;
}

export type GroupRole = 'owner' | 'member';

export interface GroupMember {
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
}

export interface Ping {
  id: string;
  /** null for anonymous public pings (ping_feed hides it). */
  author_id: string | null;
  /** null = public tier. */
  group_id: string | null;
  type: PingType;
  /** Point, WGS84. Server stores geometry(Point, 4326); the client works with lat/lon. */
  lat: number;
  lon: number;
  note: string | null;
  created_at: string;
  /** Server clock (ping_feed). Decay starts at least(created_at, received_at) so a future-dated ping cannot stay solid. */
  received_at?: string;
  expires_at: string | null;
  score: number | null;
  /** Tide height (ft MLLW) at post time, when known. */
  tide_ft: number | null;
  /** Author reputation at read time (R_a), from ping_feed. */
  author_reputation?: number;
  /** ping_feed: server-computed sum of R_i * v_i * w_i over all votes, quantized to 0.25. */
  vote_sum?: number;
  /** ping_feed: time of the latest confirm (null when none). */
  last_confirmed_at?: string | null;
  confirm_count?: number;
  dispute_count?: number;
  /** Handle shown to viewers; null/absent for anonymous public pings. */
  author_handle?: string | null;
  updated_at?: string;
}

export type VoteValue = 1 | -1;

/** The signed-in user's own vote (read from ping_votes where voter_id = auth.uid(), or queued locally). */
export interface MyVote {
  ping_id: string;
  vote: VoteValue;
  created_at: string;
}

export interface Message {
  id: string;
  group_id: string;
  author_id: string;
  body: string;
  ping_id: string | null;
  created_at: string;
  /** Server clock; the inbound sync cursor for messages. */
  received_at?: string;
  author_handle?: string | null;
  updated_at?: string;
}

/**
 * One row of a depth upload. EXACTLY these five keys — no uid, no boat id, no timestamp finer than `day`.
 *
 * Value semantics (see README / open questions): `median_ft` and `p10_ft` are charted depth in feet
 * below MLLW, positive down (depth = surface-to-bottom depth minus tide height). `p10_ft` is the 10th
 * percentile of depth, i.e. the shoal-biased value. n is the count of soundings in the cell-day.
 */
export interface DepthUploadRow {
  readonly h3_cell: string;
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly median_ft: number;
  readonly p10_ft: number;
  readonly n: number;
}

export interface TilesIndexFile {
  path: string;
  bytes: number;
}

export interface TilesIndexAoi {
  aoi: string;
  version: string;
  files: Partial<Record<TileLayer, TilesIndexFile>>;
  merged_date_range?: [string, string];
}

export interface TilesIndex {
  updated_at: string;
  aois: TilesIndexAoi[];
}

export interface TidePrediction {
  /** ISO-8601 UTC, e.g. 2026-10-09T08:00:00Z */
  t: string;
  /** Height, feet above MLLW. */
  v: number;
}

export interface TidePredictions {
  station_id: string;
  name: string;
  datum: 'MLLW';
  units: 'ft';
  /** Station coordinates (pipeline adds them from the CO-OPS metadata API); nearest-station picking uses them. */
  lat?: number;
  lon?: number;
  predictions: TidePrediction[];
}

export interface TideStation {
  station_id: string;
  name: string;
  lat: number;
  lon: number;
}
