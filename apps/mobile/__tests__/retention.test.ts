import { retentionCutoffs } from '../src/lib/retention';

describe('retention cutoffs', () => {
  const NOW = Date.parse('2026-10-09T12:00:00Z');
  const c = retentionCutoffs(NOW);
  it('pings: 48 h visibility horizon', () => expect(c.pingsBefore).toBe('2026-10-07T12:00:00.000Z'));
  it('messages: 90 days', () => expect(c.messagesBefore).toBe('2026-07-11T12:00:00.000Z'));
  it('soundings: aggregated and older than 7 days', () => expect(c.aggregatedSoundingsBeforeMs).toBe(Date.parse('2026-10-02T12:00:00Z')));
  it('sent outbox rows: 24 h', () => expect(c.sentOutboxMaxAgeMs).toBe(86_400_000));
});
