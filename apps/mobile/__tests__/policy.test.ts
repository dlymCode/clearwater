import type { TilesIndexAoi } from '@clearwater/shared';
import { canResume, createJob, isComplete, markAbsent, markDone, markFailed, markProgress, nextFile, totals } from '../src/lib/downloadState';
import { isGpsStale, shouldRender } from '../src/lib/geo';
import { decidePositionReport } from '../src/lib/positionReport';

describe('GPS staleness (MAP-5)', () => {
  it('greys after 5 s', () => {
    expect(isGpsStale(1000, 5999)).toBe(false);
    expect(isGpsStale(1000, 6000)).toBe(false);
    expect(isGpsStale(1000, 6001)).toBe(true);
    expect(isGpsStale(null, 0)).toBe(true);
  });
  it('render throttle is 2 Hz', () => {
    expect(shouldRender(0, 499)).toBe(false);
    expect(shouldRender(0, 500)).toBe(true);
  });
});

describe('position reporter policy', () => {
  const pos = { lat: 48.30837, lon: -122.50421 };
  const ok = { nowMs: 10 * 60_000, sharingEnabled: true, appForeground: true, position: pos };
  it('reports a rounded position when allowed', () => {
    const d = decidePositionReport({ lastReportMs: null }, ok);
    expect(d.report).toBe(true);
    if (d.report) expect(d.position).not.toEqual(pos);
  });
  it.each([
    [{ sharingEnabled: false }, 'sharing_off'],
    [{ appForeground: false }, 'background'],
    [{ position: null }, 'no_position'],
  ])('blocked: %j', (patch, reason) => {
    expect(decidePositionReport({ lastReportMs: null }, { ...ok, ...patch })).toEqual({ report: false, reason });
  });
  it('at most every 5 minutes', () => {
    expect(decidePositionReport({ lastReportMs: ok.nowMs - 299_999 }, ok)).toEqual({ report: false, reason: 'too_soon' });
    expect(decidePositionReport({ lastReportMs: ok.nowMs - 300_000 }, ok).report).toBe(true);
  });
});

describe('download job: optional companions', () => {
  const e: TilesIndexAoi = { aoi: 'skagit', version: 'v', files: { base: { path: 'tiles/skagit/v/base.pmtiles', bytes: 40 }, depth: { path: 'tiles/skagit/v/depth.pmtiles', bytes: 120 } } };
  it('an absent companion (400/404) completes the job without it and never counts as failed', () => {
    let j = createJob(e, ['base', 'depth'], undefined, 0);
    j = markDone(markDone(j, 'base'), 'depth');
    expect(isComplete(j)).toBe(false); // companions still pending
    j = markAbsent(markAbsent(j, 'depth_meta'), 'land');
    expect(isComplete(j)).toBe(true);
    expect(nextFile(j)).toBeNull();
    expect(totals(j).totalBytes).toBe(160);
  });
});

describe('download job state machine', () => {
  const entry = (version: string): TilesIndexAoi => ({
    aoi: 'skagit',
    version,
    files: {
      base: { path: 'tiles/skagit/v/base.pmtiles', bytes: 40 },
      depth: { path: 'tiles/skagit/v/depth.pmtiles', bytes: 120 },
      waterline: { path: 'w', bytes: 30 },
    },
  });
  const NOW = Date.parse('2026-10-09T00:00:00Z');

  it('plans only available layers', () => {
    const j = createJob(entry('v1'), ['base', 'depth', 'waterline', 'fleet'], undefined, NOW);
    // depth_meta rides along with depth and land with base (path convention, sizes not in the index)
    expect(j.files.map((f) => f.layer)).toEqual(['base', 'depth', 'waterline', 'depth_meta', 'land']);
    expect(j.files.find((f) => f.layer === 'land')!.path).toBe('tiles/skagit/v/land.pmtiles');
    expect(j.files.find((f) => f.layer === 'depth_meta')!.path).toBe('tiles/skagit/v/depth_meta.pmtiles');
    expect(totals(j).totalBytes).toBe(190);
  });

  it('resumes the partial file first after a restart (kill mid-download)', () => {
    let j = createJob(entry('v1'), ['base', 'depth', 'waterline'], undefined, NOW);
    j = markDone(j, 'base');
    j = markProgress(j, 'depth', 60, 'resume-token');
    const restored = JSON.parse(JSON.stringify(j)) as typeof j; // persisted + reloaded
    const n = nextFile(restored)!;
    expect(n.layer).toBe('depth');
    expect(n.resumeData).toBe('resume-token');
    expect(totals(restored).doneBytes).toBe(100);
    expect(canResume(restored, entry('v1'))).toBe(true);
  });

  it('a newer published version invalidates the job', () => {
    const j = createJob(entry('v1'), ['base'], undefined, NOW);
    expect(canResume(j, entry('v2'))).toBe(false);
    expect(canResume(j, undefined)).toBe(false);
  });

  it('completes, retries failed files, and ignores installed current layers', () => {
    let j = createJob(entry('v1'), ['base', 'depth'], undefined, NOW);
    j = markFailed(j, 'base');
    expect(nextFile(j)!.layer).toBe('base');
    j = markDone(markDone(markDone(markDone(j, 'base'), 'depth'), 'depth_meta'), 'land');
    expect(isComplete(j)).toBe(true);
    expect(nextFile(j)).toBeNull();
    expect(canResume(j, entry('v1'))).toBe(false);
    const skip = createJob(entry('v1'), ['base', 'depth'], { version: 'v1', layers: ['base'] }, NOW);
    expect(skip.files.map((f) => f.layer)).toEqual(['depth', 'depth_meta']); // no base requested => no land companion
  });
});
