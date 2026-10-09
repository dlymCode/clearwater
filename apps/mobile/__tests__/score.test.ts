import {
  decayFactor,
  distanceWeight,
  isVoteEligible,
  lastActivityMs,
  pingScore,
  renderState,
  summarizePing,
} from '../src/lib/score';
import type { ScoreVote } from '../src/lib/score';

const T0 = Date.parse('2026-10-09T00:00:00Z');
const H = 3_600_000;

const vote = (v: 1 | -1, dist: number | null, rep = 1, hoursAfter = 1): ScoreVote => ({
  vote: v,
  voterReputation: rep,
  voterDistM: dist,
  createdAt: T0 + hoursAfter * H,
});

describe('distance weight w(d)', () => {
  it.each([
    [0, 1],
    [199.9, 1],
    [200, 1],
    [200.01, 0.5],
    [500, 0.5],
    [500.01, 0],
    [2000, 0],
    [null, 0],
  ])('d=%s => %s', (d, w) => {
    expect(distanceWeight(d)).toBe(w);
  });
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
    const base = { authorReputation: 1, createdAt: T0, votes: [] as ScoreVote[] };
    expect(pingScore({ ...base, now: T0 })).toBe(1);
    const s24 = pingScore({ ...base, now: T0 + 24 * H });
    expect(s24).toBeCloseTo(0.5, 12);
    expect(renderState(s24 - 1e-9)).toBe('faded'); // exactly 0.5 is "normal" (>= 0.5); just under is faded
    expect(renderState(pingScore({ ...base, now: T0 + 30 * H }))).toBe('faded');
    expect(renderState(pingScore({ ...base, now: T0 + 48.01 * H }))).toBe('hidden');
  });
  it('S at exactly 48 h is 0.25 +- float noise (the hidden boundary; not relied on)', () => {
    const s = pingScore({ authorReputation: 1, createdAt: T0, votes: [], now: T0 + 48 * H });
    expect(s).toBeCloseTo(0.25, 12);
  });
  it('negative age (device clock behind) is clamped to 0', () => {
    expect(pingScore({ authorReputation: 1.2, createdAt: T0, votes: [], now: T0 - 5 * H })).toBeCloseTo(1.2, 12);
  });
});

describe('golden vectors (the SQL function must produce these)', () => {
  // [description, authorRep, votes, hoursSinceCreate, expected]
  const cases: Array<[string, number, ScoreVote[], number, number]> = [
    ['fresh, no votes', 1.0, [], 0, 1],
    ['24h, no votes', 1.0, [], 24, 0.5],
    ['author rep 2.0 at 12h', 2.0, [], 12, 2 * Math.exp(-(Math.LN2 / 24) * 12)],
    // confirm at +1h from a boat 100 m away (w=1, R=1): t_last = T0+1h, now = T0+10h => age 9h
    ['one near confirm', 1.0, [vote(1, 100)], 10, 2 * Math.exp(-(Math.LN2 / 24) * 9)],
    // confirm at 400 m (w=0.5) with rep 1.5: 1 + 0.75
    ['one mid confirm rep 1.5', 1.0, [vote(1, 400, 1.5)], 1, 1.75],
    // vote from 2 km counts for nothing (S6-4)
    ['far confirm has zero weight', 1.0, [vote(1, 2000)], 1, 1],
    // dispute at 150 m: 1 - 1 = 0
    ['near dispute cancels', 1.0, [vote(-1, 150, 1, 0)], 0, 0],
    // 2 confirms + 1 dispute: 1 + (1*1) + (0.5*0.5) - (1*1)
    [
      'mixed votes',
      1.0,
      [vote(1, 100, 1, 2), vote(1, 450, 0.5, 3), vote(-1, 100, 1, 4)],
      4,
      (1 + 1 + 0.25 - 1) * Math.exp(-(Math.LN2 / 24) * 1),
    ],
  ];
  it.each(cases)('%s', (_name, rep, votes, hours, expected) => {
    const s = pingScore({ authorReputation: rep, createdAt: T0, votes, now: T0 + hours * H });
    expect(s).toBeCloseTo(expected, 12);
  });
});

describe('t_last', () => {
  it('uses latest confirm, ignores disputes', () => {
    const votes = [vote(1, 100, 1, 3), vote(-1, 100, 1, 9), vote(1, 100, 1, 5)];
    expect(lastActivityMs(T0, votes)).toBe(T0 + 5 * H);
  });
  it('a reconfirmation resets decay so an old ping reappears', () => {
    const votes = [vote(1, 100, 1, 46)];
    // created 50 h ago: alone it would be hidden
    const alone = pingScore({ authorReputation: 1, createdAt: T0, votes: [], now: T0 + 50 * H });
    expect(renderState(alone)).toBe('hidden');
    const reconf = pingScore({ authorReputation: 1, createdAt: T0, votes, now: T0 + 50 * H });
    expect(reconf).toBeGreaterThan(1.5); // 2 * 2^(-4/24)
    expect(renderState(reconf)).toBe('solid');
  });
  it('accepts ISO strings and Dates', () => {
    const s = pingScore({
      authorReputation: 1,
      createdAt: '2026-10-09T00:00:00Z',
      votes: [],
      now: new Date('2026-10-10T00:00:00Z'),
    });
    expect(s).toBeCloseTo(0.5, 12);
  });
});

describe('render state thresholds', () => {
  it.each([
    [-1, 'hidden'],
    [0, 'hidden'],
    [0.2499999, 'hidden'],
    [0.25, 'faded'],
    [0.4999999, 'faded'],
    [0.5, 'normal'],
    [1.0, 'normal'],
    [1.5, 'normal'],
    [1.5000001, 'solid'],
    [3, 'solid'],
  ])('S=%s => %s', (s, state) => {
    expect(renderState(s)).toBe(state);
  });
});

describe('summarizePing', () => {
  it('counts confirms and disputes', () => {
    const r = summarizePing({
      authorReputation: 1,
      createdAt: T0,
      votes: [vote(1, 100), vote(1, 100), vote(-1, 100)],
      now: T0 + H,
    });
    expect(r.confirms).toBe(2);
    expect(r.disputes).toBe(1);
  });
});
