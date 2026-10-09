/**
 * Client-side model for pings, votes and messages: validation, outbox payloads, visibility.
 * The two-tap flow: tap 1 picks the type, tap 2 confirms. Note optional (<= 140 chars).
 */
import {
  MESSAGE_BODY_MAX,
  PING_NOTE_MAX,
  isPingType,
  type Ping,
  type PingType,
  type MyVote,
  type PingVote,
  type VoteValue,
} from '@clearwater/shared';
import { isValidLatLon } from './geo';
import { fallbackScore, isVoteEligible, renderState, summarizePing, type Instant, type PingSummary, type ScoreVote } from './score';

const charLength = (s: string): number => Array.from(s).length;

export type NoteCheck = { ok: true; note: string | null } | { ok: false; error: string };

export function validateNote(note: string | null | undefined): NoteCheck {
  const t = (note ?? '').trim();
  if (t.length === 0) return { ok: true, note: null };
  if (/[\r\n]/.test(t)) return { ok: false, error: 'Note must be one line.' };
  if (charLength(t) > PING_NOTE_MAX) return { ok: false, error: `Note is limited to ${PING_NOTE_MAX} characters.` };
  return { ok: true, note: t };
}

export interface PingDraft {
  type: PingType | null;
  lat: number;
  lon: number;
  note?: string | null;
  /** null = public tier. */
  groupId: string | null;
  /** Public tier only: carry reputation but not the handle. */
  anonymous?: boolean;
}

export function canSubmitPing(d: PingDraft): { ok: true } | { ok: false; error: string } {
  if (!d.type || !isPingType(d.type)) return { ok: false, error: 'Pick a ping type.' };
  if (!isValidLatLon(d.lat, d.lon)) return { ok: false, error: 'No valid position.' };
  const n = validateNote(d.note);
  if (!n.ok) return n;
  if (d.anonymous && d.groupId) return { ok: false, error: 'Anonymous pings are public-tier only.' };
  return { ok: true };
}

/** Wire payload for an INSERT into `pings` (author_id is set server-side from auth.uid()). */
export interface PingPayload {
  id: string;
  group_id: string | null;
  type: PingType;
  lat: number;
  lon: number;
  note: string | null;
  created_at: string;
  tide_ft: number | null;
  anonymous: boolean;
}

export function buildPingPayload(
  d: PingDraft,
  ctx: { id: string; nowMs: number; tideFt: number | null },
): PingPayload {
  const ok = canSubmitPing(d);
  if (!ok.ok) throw new Error(ok.error);
  const note = validateNote(d.note);
  return {
    id: ctx.id,
    group_id: d.groupId,
    type: d.type as PingType,
    lat: Number(d.lat.toFixed(6)),
    lon: Number(d.lon.toFixed(6)),
    note: note.ok ? note.note : null,
    created_at: new Date(ctx.nowMs).toISOString(),
    tide_ft: ctx.tideFt === null ? null : Number(ctx.tideFt.toFixed(2)),
    anonymous: d.anonymous === true,
  };
}

/** Wire payload for ping_votes. voter_dist_m is computed server-side from last_positions. */
export interface VotePayload {
  ping_id: string;
  vote: VoteValue;
  created_at: string;
}

export function buildVotePayload(pingId: string, vote: VoteValue, nowMs: number): VotePayload {
  if (vote !== 1 && vote !== -1) throw new Error('vote must be +1 or -1');
  return { ping_id: pingId, vote, created_at: new Date(nowMs).toISOString() };
}

export interface MessagePayload {
  id: string;
  group_id: string;
  body: string;
  ping_id: string | null;
  created_at: string;
}

export function validateMessageBody(body: string): { ok: true; body: string } | { ok: false; error: string } {
  const t = body.trim();
  if (t.length === 0) return { ok: false, error: 'Message is empty.' };
  if (charLength(t) > MESSAGE_BODY_MAX) return { ok: false, error: `Messages are limited to ${MESSAGE_BODY_MAX} characters.` };
  return { ok: true, body: t };
}

export function buildMessagePayload(
  groupId: string,
  body: string,
  ctx: { id: string; nowMs: number; pingId?: string | null },
): MessagePayload {
  const v = validateMessageBody(body);
  if (!v.ok) throw new Error(v.error);
  return { id: ctx.id, group_id: groupId, body: v.body, ping_id: ctx.pingId ?? null, created_at: new Date(ctx.nowMs).toISOString() };
}

// --- Visibility --------------------------------------------------------------------------------

export function toScoreVotes(votes: readonly PingVote[]): ScoreVote[] {
  return votes.map((v) => ({
    vote: v.vote,
    // Callers must check reputationsKnown() first; these defaults are never used for display scoring.
    voterReputation: v.voter_reputation ?? 0,
    weight: v.weight ?? 0,
    createdAt: v.created_at,
  }));
}

/** True when the author's reputation and every vote's reputation AND server-computed weight came from the feeds. */
export function reputationsKnown(ping: Ping, votes: readonly PingVote[]): boolean {
  return (
    typeof ping.author_reputation === 'number' &&
    votes.every((v) => typeof v.voter_reputation === 'number' && typeof v.weight === 'number')
  );
}

export interface ScoredPing {
  ping: Ping;
  summary: PingSummary;
  /** Queued in the outbox and not yet accepted by the server (includes rows the server rejected: they need a retry). */
  pendingSync: boolean;
  /** Score came from the server's cached value decayed to now (reputations were missing). */
  scoreIsFallback: boolean;
}

/**
 * Score every ping from timestamps alone (works offline), drop hidden ones, and mark pending-sync.
 * With reputations (ping_feed / ping_votes_feed) the full formula runs on-device. Without them, the server's
 * cached score decayed by exp(-lambda * (now - updated_at)) is used; never a default reputation of 1.0.
 * Pings the user just created and that are still unsynced are always shown (even if clocks drift).
 */
export function visiblePings(
  pings: readonly Ping[],
  votesByPing: ReadonlyMap<string, readonly PingVote[]>,
  nowMs: Instant,
  unsyncedIds: ReadonlySet<string> = new Set(),
): ScoredPing[] {
  const out: ScoredPing[] = [];
  for (const ping of pings) {
    const votes = votesByPing.get(ping.id) ?? [];
    let summary: PingSummary;
    let fallback = false;
    if (reputationsKnown(ping, votes)) {
      summary = summarizePing({
        authorReputation: ping.author_reputation as number,
        createdAt: ping.created_at,
        receivedAt: ping.received_at ?? null,
        votes: toScoreVotes(votes),
        now: nowMs,
      });
    } else {
      const fb = fallbackScore(ping.score, ping.updated_at ?? ping.created_at, nowMs);
      if (fb === null) {
        // Nothing trustworthy to score with: only locally queued pings are shown.
        if (!unsyncedIds.has(ping.id)) continue;
        summary = { score: 1, state: 'normal', confirms: 0, disputes: 0 };
      } else {
        summary = { score: fb, state: renderState(fb), confirms: votes.filter((v) => v.vote === 1).length, disputes: votes.filter((v) => v.vote === -1).length };
      }
      fallback = true;
    }
    const pendingSync = unsyncedIds.has(ping.id);
    if (summary.state === 'hidden' && !pendingSync) continue;
    out.push({ ping, summary, pendingSync, scoreIsFallback: fallback });
  }
  return out;
}

export interface VoteAvailability {
  confirm: boolean;
  dispute: boolean;
  reason: string | null;
}

/**
 * One-tap vote buttons (FLT-2): no voting on your own ping, none on unsynced pings, none twice, and a confirm
 * needs you within 500 m (disputes are always allowed; the server stores the real distance).
 */
export function voteAvailability(i: {
  isOwn: boolean;
  pendingSync: boolean;
  alreadyVoted: boolean;
  distanceToPingM: number | null;
}): VoteAvailability {
  if (i.isOwn) return { confirm: false, dispute: false, reason: 'You posted this ping.' };
  if (i.pendingSync) return { confirm: false, dispute: false, reason: 'Waiting to sync.' };
  if (i.alreadyVoted) return { confirm: false, dispute: false, reason: 'You already voted.' };
  const near = isVoteEligible(i.distanceToPingM);
  return { confirm: near, dispute: true, reason: near ? null : 'Get within 500 m to confirm (position sharing must be on).' };
}

/** The user's own vote, recorded locally the moment it is queued (reconciled with ping_votes where voter_id = me). */
export function optimisticVote(pingId: string, vote: VoteValue, nowMs: number): MyVote {
  return { ping_id: pingId, vote, created_at: new Date(nowMs).toISOString() };
}

/** Row of ping_votes_feed: (ping_id, vote, created_at, voter_reputation, weight). No voter id, no distance. */
export function normalizeVoteRow(raw: unknown): PingVote | null {
  const row = asObj(raw);
  if (!row || typeof row.ping_id !== 'string' || typeof row.created_at !== 'string') return null;
  if (row.vote !== 1 && row.vote !== -1) return null;
  return {
    ping_id: row.ping_id,
    vote: row.vote,
    created_at: row.created_at,
    ...(typeof row.voter_reputation === 'number' ? { voter_reputation: row.voter_reputation } : {}),
    ...(typeof row.weight === 'number' ? { weight: row.weight } : {}),
  };
}

/** Stable local key for a feed vote row (the feed hides voter_id, so there is no natural key). */
export function voteRowKey(row: Record<string, unknown>): string {
  return `${String(row.ping_id)}|${String(row.created_at)}|${String(row.vote)}|${String(row.voter_reputation ?? '')}|${String(row.weight ?? '')}`;
}

// --- Wire <-> domain ---------------------------------------------------------------------------

const asObj = (x: unknown): Record<string, unknown> | null => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null);

/** PostgREST returns PostGIS geometry as GeoJSON ({type:'Point', coordinates:[lon,lat]}); also accept lat/lon. */
export function pointOf(row: Record<string, unknown>): { lat: number; lon: number } | null {
  const g = asObj(row.geom);
  const coords = g && Array.isArray(g.coordinates) ? (g.coordinates as unknown[]) : null;
  if (coords && typeof coords[0] === 'number' && typeof coords[1] === 'number') return { lon: coords[0], lat: coords[1] };
  if (typeof row.lat === 'number' && typeof row.lon === 'number') return { lat: row.lat, lon: row.lon };
  return null;
}

/**
 * Server `pings` row (or our own queued PingPayload) => Ping. Returns null for rows that cannot be drawn.
 * Read from the `ping_feed` view: it carries `author_reputation` and nulls author_id/handle on anonymous pings.
 * A missing reputation is left undefined (visiblePings then uses the decayed server score, never a default 1.0).
 */
export function normalizePingRow(raw: unknown): Ping | null {
  const row = asObj(raw);
  if (!row) return null;
  const pt = pointOf(row);
  if (!pt || typeof row.id !== 'string' || typeof row.created_at !== 'string' || !isPingType(row.type)) return null;
  return {
    id: row.id,
    author_id: typeof row.author_id === 'string' ? row.author_id : null,
    group_id: typeof row.group_id === 'string' ? row.group_id : null,
    type: row.type,
    lat: pt.lat,
    lon: pt.lon,
    note: typeof row.note === 'string' ? row.note : null,
    created_at: row.created_at,
    ...(typeof row.received_at === 'string' ? { received_at: row.received_at } : {}),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    score: typeof row.score === 'number' ? row.score : null,
    tide_ft: typeof row.tide_ft === 'number' ? row.tide_ft : null,
    ...(typeof row.author_reputation === 'number' ? { author_reputation: row.author_reputation } : {}),
    ...(typeof row.author_handle === 'string' ? { author_handle: row.author_handle } : {}),
    ...(typeof row.updated_at === 'string' ? { updated_at: row.updated_at } : {}),
  };
}

/** A just-queued ping as a local Ping so it shows immediately (with the pending mark). */
export function pingFromPayload(p: PingPayload, authorId: string | null = null): Ping {
  return {
    id: p.id, author_id: authorId, group_id: p.group_id, type: p.type, lat: p.lat, lon: p.lon, note: p.note,
    created_at: p.created_at, expires_at: null, score: null, tide_ft: p.tide_ft,
  };
}
