import type { TilesIndex } from '@clearwater/shared';
import {
  availableLayers,
  depthMetaPath,
  diffInstalled,
  downloadSizeBytes,
  formatBytes,
  latestByAoi,
  layersToDownload,
  parseTilesIndex,
  resolveTilePath,
  versionNewer,
} from '../src/lib/tilesIndex';

const entry = (aoi: string, version: string, bytes = [40, 120, 30, 10]) => ({
  aoi,
  version,
  files: {
    base: { path: `tiles/${aoi}/${version}/base.pmtiles`, bytes: bytes[0]! * 1e6 },
    depth: { path: `tiles/${aoi}/${version}/depth.pmtiles`, bytes: bytes[1]! * 1e6 },
    waterline: { path: `tiles/${aoi}/${version}/waterline.pmtiles`, bytes: bytes[2]! * 1e6 },
    fleet: { path: `tiles/${aoi}/${version}/fleet.pmtiles`, bytes: bytes[3]! * 1e6 },
  },
  merged_date_range: ['1887-01-01', '2026-09-30'] as [string, string],
});

const sample = {
  updated_at: '2026-10-09T00:00:00Z',
  aois: [entry('skagit', '2026-10-09T00:00:00Z'), entry('port_susan', '2026-10-02T00:00:00Z')],
};

describe('parseTilesIndex', () => {
  it('parses the AGENT-PLAN shape', () => {
    const r = parseTilesIndex(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.index.aois).toHaveLength(2);
      expect(r.index.aois[0]!.files.depth!.bytes).toBe(120e6);
      expect(r.index.aois[0]!.merged_date_range).toEqual(['1887-01-01', '2026-09-30']);
      expect(r.issues).toEqual([]);
    }
  });

  it('ignores unknown fields at every level', () => {
    const r = parseTilesIndex({
      ...sample,
      schema: 3,
      aois: [{ ...entry('skagit', 'v1'), extra: { a: 1 }, files: { ...entry('skagit', 'v1').files, currents: { path: 'x', bytes: 1 } } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.index.aois[0]!.files).sort()).toEqual(['base', 'depth', 'fleet', 'waterline']);
  });

  it('optional layers may be absent (fleet not built yet)', () => {
    const e = entry('skagit', 'v1');
    const { fleet: _f, ...files } = e.files;
    void _f;
    const r = parseTilesIndex({ ...sample, aois: [{ ...e, files }] });
    expect(r.ok && r.index.aois[0]!.files.fleet).toBeFalsy();
    expect(r.ok).toBe(true);
  });

  it('skips AOIs missing required layers or fields but keeps the rest, reporting issues', () => {
    const r = parseTilesIndex({
      ...sample,
      aois: [
        { aoi: 'bad', version: 'v', files: { base: { path: 'p', bytes: 1 } } },
        { version: 'v', files: {} },
        'junk',
        entry('skagit', 'v1'),
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.index.aois.map((a) => a.aoi)).toEqual(['skagit']);
      expect(r.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects structurally broken indexes', () => {
    expect(parseTilesIndex(null).ok).toBe(false);
    expect(parseTilesIndex({ aois: [] }).ok).toBe(false);
    expect(parseTilesIndex({ updated_at: 'nope', aois: [] }).ok).toBe(false);
    expect(parseTilesIndex({ updated_at: '2026-10-09T00:00:00Z', aois: 'x' }).ok).toBe(false);
  });

  it('bytes == 0 means "not available yet": layer treated as absent, AOI still usable', () => {
    const e = entry('skagit', 'v1', [40, 120, 30, 0]);
    const r = parseTilesIndex({ ...sample, aois: [e] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.index.aois[0]!.files.fleet).toBeUndefined();
      expect(r.issues).toEqual([]);
      expect(availableLayers(r.index.aois[0]!)).toEqual(['base', 'depth', 'waterline']);
      expect(downloadSizeBytes(r.index.aois[0]!)).toBe(190e6);
    }
    // a missing required layer (depth not built) makes the AOI unusable
    expect(parseTilesIndex({ ...sample, aois: [entry('skagit', 'v1', [40, 0, 0, 0])] }).ok && (parseTilesIndex({ ...sample, aois: [entry('skagit', 'v1', [40, 0, 0, 0])] }) as { index: TilesIndex }).index.aois).toHaveLength(0);
  });

  it('layersToDownload ignores 0-byte entries even on hand-built objects', () => {
    expect(layersToDownload(entry('skagit', 'v1', [40, 120, 30, 0]), ['base', 'fleet'])).toEqual(['base']);
  });

  it('depth_meta path follows the convention next to depth.pmtiles (not in the index)', () => {
    expect(depthMetaPath(entry('skagit', 'v1'))).toBe('tiles/skagit/v1/depth_meta.pmtiles');
  });

  it('path safety: a hostile index cannot smuggle traversal, odd aoi slugs or odd versions', () => {
    const e = entry('skagit', 'v1');
    const evil = (patch: Record<string, unknown>) => parseTilesIndex({ ...sample, aois: [{ ...e, ...patch }] });
    const count = (r: ReturnType<typeof parseTilesIndex>) => (r.ok ? r.index.aois.length : -1);
    expect(count(evil({ aoi: '../etc' }))).toBe(0);
    expect(count(evil({ aoi: 'Skagit' }))).toBe(0);
    expect(count(evil({ aoi: 'a/b' }))).toBe(0);
    expect(count(evil({ version: '../../x' }))).toBe(0);
    expect(count(evil({ version: 'a/b' }))).toBe(0);
    expect(count(evil({ files: { ...e.files, base: { path: 'tiles/skagit/v1/../../../etc/passwd', bytes: 5 } } }))).toBe(0);
    expect(count(evil({ files: { ...e.files, base: { path: '/abs/base.pmtiles', bytes: 5 } } }))).toBe(0);
    expect(count(evil({ files: { ...e.files, base: { path: 'tiles/skagit/v1/base.exe', bytes: 5 } } }))).toBe(0);
    expect(count(evil({ files: { ...e.files, base: { path: 'tiles/other/v1/a/base.pmtiles', bytes: 5 } } }))).toBe(0);
    // an unsafe OPTIONAL layer is dropped, the AOI survives
    const r = evil({ files: { ...e.files, fleet: { path: 'tiles/skagit/v1/../x.pmtiles', bytes: 5 } } });
    expect(count(r)).toBe(1);
    if (r.ok) expect(r.index.aois[0]!.files.fleet).toBeUndefined();
    expect(count(evil({}))).toBe(1);
  });

  it('negative or non-numeric bytes invalidate that file', () => {
    const e = entry('skagit', 'v1');
    const r = parseTilesIndex({ ...sample, aois: [{ ...e, files: { ...e.files, depth: { path: 'p', bytes: -1 } } }] });
    expect(r.ok && r.index.aois.length).toBe(0);
  });
});

describe('versions and sizes', () => {
  it('versionNewer compares ISO times, not strings of different shape', () => {
    expect(versionNewer('2026-10-09T00:00:00Z', '2026-10-02T00:00:00Z')).toBe(true);
    expect(versionNewer('2026-10-09T00:00:00Z', '2026-10-09T00:00:00Z')).toBe(false);
  });

  it('latestByAoi picks the newest version when several are listed', () => {
    const idx: TilesIndex = {
      updated_at: sample.updated_at,
      aois: [entry('skagit', '2026-09-01T00:00:00Z'), entry('skagit', '2026-10-09T00:00:00Z'), entry('skagit', '2026-08-01T00:00:00Z')],
    };
    expect(latestByAoi(idx).get('skagit')!.version).toBe('2026-10-09T00:00:00Z');
  });

  it('computes download size across layers', () => {
    const e = entry('skagit', 'v1');
    expect(downloadSizeBytes(e)).toBe(200e6);
    expect(downloadSizeBytes(e, ['base', 'depth'])).toBe(160e6);
  });

  it('only counts layers that changed or are missing when something is installed', () => {
    const e = entry('skagit', 'v2');
    expect(downloadSizeBytes(e, undefined, { version: 'v2' })).toBe(0);
    expect(downloadSizeBytes(e, undefined, { version: 'v1' })).toBe(200e6);
    expect(layersToDownload(e, ['base', 'depth', 'fleet'], { version: 'v2', layers: ['base', 'depth'] })).toEqual(['fleet']);
  });

  it('subtracts bytes already resumed', () => {
    expect(downloadSizeBytes(entry('skagit', 'v1'), undefined, undefined, 50e6)).toBe(150e6);
    expect(downloadSizeBytes(entry('skagit', 'v1'), undefined, undefined, 999e6)).toBe(0);
  });

  it('diffInstalled flags new / update / current', () => {
    const idx: TilesIndex = { updated_at: sample.updated_at, aois: [entry('skagit', 'v2'), entry('port_susan', 'v1'), entry('nisqually', 'v1')] };
    const d = diffInstalled(idx, { skagit: { version: 'v1' }, port_susan: { version: 'v1' } });
    expect(d.map((x) => [x.aoi, x.status])).toEqual([
      ['nisqually', 'new'],
      ['port_susan', 'current'],
      ['skagit', 'update'],
    ]);
    expect(d.find((x) => x.aoi === 'port_susan')!.bytesToDownload).toBe(0);
    expect(d.find((x) => x.aoi === 'skagit')!.installedVersion).toBe('v1');
  });

  it('formatBytes and resolveTilePath', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(200e6)).toBe('191 MB');
    expect(formatBytes(-1)).toBe('unknown');
    expect(resolveTilePath('https://t.example.com/', '/tiles/a/b.pmtiles')).toBe('https://t.example.com/tiles/a/b.pmtiles');
  });
});
