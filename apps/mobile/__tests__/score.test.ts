import { decayFactor, decayOriginMs, distanceWeight, fallbackScore, isVoteEligible, lastActivityMs, pingScore, renderState, summarizePing } from '../src/lib/score';

const T0 = Date.parse('2026-10-09T00:00:00Z');
const H = 3_600_000;
const at = (hoursAfter: number) => T0 + hoursAfter * H;
const base = { authorReputation: 1, createdAt: T0, voteSum: 0 };

describe('client-side distance weight (button hint only)', () => {
  it.each([
    [0, 1], [199.9, 1], [200, 1], [200.01, 0.5], [500, 0.5], [500.01, 0], [2000, 0], [null, 0],
  ])('d=%s => %s', (d, w) => expect(distanceWeight(d)).toBe(w));
  it('vote eligibility is within 500 m', () => {
    expect(isVoteEligible(100)).toBe(true);
    expect(isVoteEligible(500)).toBe(true);
    expect(isVoteEligible(500.1)).toBe(false);
    expect(isVoteEligible(null)).toBe(false);
  });
});

describe('decay', () => {
  it('half at 24 h, quarter at 48 h', () => {
    expect(decayFactor(0)).toBe(1);
    expect(decayFactor(24)).toBeCloseTo(0.5, 12);
    expect(decayFactor(48)).toBeCloseTo(0.25, 12);
  });
  it('unconfirmed ping with R=1 is faded at 24 h and hidden by 48 h+', () => {
    expect(pingScore({ ...base, now: T0 })).toBe(1);
    const s24 = pingScore({ ...base, now: at(24) });
    expect(s24).toBeCloseTo(0.5, 12);
    expect(renderState(s24 - 1e-9)).toBe('faded');
    expect(renderState(pingScore({ ...base, now: at(30) }))).toBe('faded');
    expect(renderState(pingScore({ ...base, now: at(48.01) }))).toBe('hidden');
  });
  it('negative age (device clock behind) is clamped to 0', () => {
    expect(pingScore({ ...base, authorReputation: 1.2, now: at(-5) })).toBeCloseTo(1.2, 12);
  });
});

describe('S = R_a * (1 + vote_sum) * exp(-lambda * (now - max(t0, last_confirmed_at)))', () => {
  const cases: Array<[string, Parameters<typeof pingScore>[0], number]> = [
    ['fresh, no votes', { ...base, now: T0 }, 1],
    ['24h, no votes', { ...base, now: at(24) }, 0.5],
    ['author rep 2.0 at 12h', { ...base, authorReputation: 2, now: at(12) }, 2 * Math.exp(-(Math.LN2 / 86400) * 12 * 3600)],
    // vote_sum 1.5 (e.g. one rep-1.5 voter at weight 1), confirmed at +1h, now +10h => decay over 9h
    ['confirmed: decay restarts at last_confirmed_at', { ...base, voteSum: 1.5, lastConfirmedAt: at(1), now: at(10) }, 2.5 * Math.exp(-(Math.LN2 / 86400) * 9 * 3600)],
    ['pure disputes cancel', { ...base, voteSum: -1, now: at(0) }, 0],
    ['mixed (server already summed): 0.25 quantum', { ...base, authorReputation: 1.1, voteSum: 0.75, now: at(4) }, 1.1 * 1.75 * Math.exp(-(Math.LN2 / 86400) * 4 * 3600)],
  ];
  it.each(cases)('%s', (_n, input, expected) => expect(pingScore(input)).toBeCloseTo(expected, 12));

  it('an old confirm does not move t_last backwards', () => {
    expect(lastActivityMs(at(5), at(2))).toBe(at(5));
    expect(lastActivityMs(at(5), null)).toBe(at(5));
    expect(lastActivityMs(at(5), undefined)).toBe(at(5));
    expect(lastActivityMs(at(5), 'garbage')).toBe(at(5));
  });
  it('a reconfirmation resets decay so an old ping reappears', () => {
    const alone = pingScore({ ...base, now: at(50) });
    expect(renderState(alone)).toBe('hidden');
    const reconf = pingScore({ ...base, voteSum: 1, lastConfirmedAt: at(46), now: at(50) });
    expect(reconf).toBeGreaterThan(1.5); // 2 * 2^(-4/24)
    expect(renderState(reconf)).toBe('solid');
  });
  it('accepts ISO strings and Dates', () => {
    expect(pingScore({ ...base, createdAt: '2026-10-09T00:00:00Z', now: new Date('2026-10-10T00:00:00Z') })).toBeCloseTo(0.5, 12);
  });
});

describe('t0 = least(created_at, received_at): a future-dated ping cannot stay solid', () => {
  it('decay starts at the earlier of device and server time', () => {
    const input = { ...base, createdAt: at(10), now: at(24) };
    const honest = pingScore({ ...input, receivedAt: T0 });
    expect(honest).toBeCloseTo(0.5, 12);
    expect(pingScore(input)).toBeGreaterThan(honest);
  });
  it('received_at later than created_at (offline ping synced later) does not shorten decay', () => {
    expect(pingScore({ ...base, receivedAt: at(20), now: at(24) })).toBeCloseTo(0.5, 12);
  });
  it('no received_at (local unsynced ping) uses created_at; null is the same as absent', () => {
    expect(pingScore({ ...base, receivedAt: null, now: at(12) })).toBe(pingScore({ ...base, now: at(12) }));
    expect(decayOriginMs(at(3), null)).toBe(at(3));
    expect(decayOriginMs(at(3), at(1))).toBe(at(1));
    expect(decayOriginMs(at(3), 'garbage')).toBe(at(3));
  });
  it('a confirm after t0 still resets t_last', () => {
    const s = pingScore({ ...base, createdAt: at(5), receivedAt: T0, voteSum: 1, lastConfirmedAt: at(20), now: at(24) });
    expect(s).toBeCloseTo(2 * Math.pow(0.5, 4 / 24), 12);
  });
});

describe('render state thresholds', () => {
  it.each([
    [-1, 'hidden'], [0, 'hidden'], [0.2499999, 'hidden'], [0.25, 'faded'], [0.4999999, 'faded'],
    [0.5, 'normal'], [1.0, 'normal'], [1.5, 'normal'], [1.5000001, 'solid'], [3, 'solid'],
  ])('S=%s => %s', (s, state) => expect(renderState(s)).toBe(state));

  it('unparsable scores are hidden, never solid', () => {
    expect(renderState(Number.NaN)).toBe('hidden');
    expect(renderState(Number.POSITIVE_INFINITY)).toBe('solid'); // a real (if absurd) number
    expect(renderState(undefined as unknown as number)).toBe('hidden');
    expect(renderState(pingScore({ ...base, createdAt: 'garbage', now: T0 }))).toBe('hidden');
  });
});

describe('summarizePing uses the server counts', () => {
  it('confirms/disputes come from ping_feed columns', () => {
    const r = summarizePing({ ...base, now: at(1), confirmCount: 2, disputeCount: 1 });
    expect(r).toMatchObject({ confirms: 2, disputes: 1 });
    expect(summarizePing({ ...base, now: at(1) })).toMatchObject({ confirms: 0, disputes: 0 });
  });
});

describe('fallbackScore', () => {
  it('decays the cached server score since updated_at; null inputs give null', () => {
    expect(fallbackScore(2, at(0), at(24))).toBeCloseTo(1, 12);
    expect(fallbackScore(null, at(0), at(1))).toBeNull();
    expect(fallbackScore(2, null, at(1))).toBeNull();
    expect(fallbackScore(Number.NaN, at(0), at(1))).toBeNull();
  });
});
