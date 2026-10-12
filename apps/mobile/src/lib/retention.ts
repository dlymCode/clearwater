/**
 * Local retention (private store hygiene): cutoffs only, so the policy is testable. services/retention.ts applies
 * them with SQL on every sync.
 *
 *  - pings: dropped once COALESCE(updated_at, created_at) is older than the 48 h visibility horizon (a reconfirmation
 *    bumps updated_at, so revived pings stay), except pings still waiting in the outbox;
 *  - own-vote rows follow their pings;
 *  - messages: 90 days (server retention);
 *  - raw soundings: only after they were aggregated AND are older than 7 days (the complete-day re-aggregation needs
 *    the day's soundings to stay around until the day's last batch has certainly been queued);
 *  - sent outbox rows: after 24 h.
 */
import { MESSAGE_RETENTION_DAYS, MS_PER_DAY, MS_PER_HOUR, PING_VISIBLE_HOURS } from '@clearwater/shared';

export const SOUNDING_RETENTION_DAYS = 7;
export const SENT_OUTBOX_RETENTION_HOURS = 24;

export interface RetentionCutoffs {
  /** ISO: delete pings whose COALESCE(updated_at, created_at) is before this. */
  pingsBefore: string;
  messagesBefore: string;
  /** Epoch ms: delete AGGREGATED soundings with t_ms before this. */
  aggregatedSoundingsBeforeMs: number;
  sentOutboxMaxAgeMs: number;
}

export function retentionCutoffs(nowMs: number): RetentionCutoffs {
  return {
    pingsBefore: new Date(nowMs - PING_VISIBLE_HOURS * MS_PER_HOUR).toISOString(),
    messagesBefore: new Date(nowMs - MESSAGE_RETENTION_DAYS * MS_PER_DAY).toISOString(),
    aggregatedSoundingsBeforeMs: nowMs - SOUNDING_RETENTION_DAYS * MS_PER_DAY,
    sentOutboxMaxAgeMs: SENT_OUTBOX_RETENTION_HOURS * MS_PER_HOUR,
  };
}
