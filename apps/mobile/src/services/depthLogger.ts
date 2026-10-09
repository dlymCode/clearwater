/**
 * Passive depth logger: NMEA snapshot -> physical filters -> offset + tide correction -> SQLCipher store
 * -> (periodically) H3/day aggregation -> outbox depth_batch. Raw soundings never leave the device.
 */
import { useAppStore } from '../state/store';
import { aggregateSoundings, buildUploadPayload, type CorrectedSounding } from '../lib/aggregate';
import { soundingBatchId } from '../lib/outbox';
import { uuidv4 } from '../lib/uuid';
import { DepthFilter } from '../lib/depthFilter';
import type { InstrumentSnapshot } from '../lib/nmea';
import type { Outbox } from '../lib/outbox';
import { correctToMllw, interpolateTide, nearestStation } from '../lib/tide';
import { getDb, kvGet, kvSet, runTx } from './db';
import { loadSeries, stationRegistry } from './tideService';

const AGGREGATE_EVERY_MS = 10 * 60 * 1000;

export class DepthLogger {
  private filter = new DepthFilter();
  private registry: Awaited<ReturnType<typeof stationRegistry>> | null = null;
  private registryAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly outbox: Outbox) {}

  start(): void {
    this.filter = new DepthFilter();
    this.timer ??= setInterval(() => void this.aggregateAndEnqueue(), AGGREGATE_EVERY_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.aggregateAndEnqueue();
  }

  /** Station registry (cached tide JSON coordinates + bundled list), refreshed every 10 minutes. */
  private async stations() {
    if (!this.registry || Date.now() - this.registryAt > 10 * 60_000) {
      this.registry = await stationRegistry();
      this.registryAt = Date.now();
    }
    return this.registry;
  }

  // TODO(item 18, not implemented): (a) phone-GPS fallback. Sounder-only gateways send DPT/DBT but no GGA/RMC, so
  // lat/lon/SOG are null and every reading is dropped by DepthFilter. Join the phone's expo-location fix (position,
  // speed, and accuracy as an HDOP proxy) into the snapshot when NMEA position is missing. (b) The DPT offset field
  // (transducer offset reported by the sounder) is ignored; warn when it is non-zero and the user also set an offset,
  // because the depth may already be corrected and would be double counted.
  /** Feed one instrument snapshot. Returns the corrected depth for the UI numeral (even if not logged). */
  async onSnapshot(snap: InstrumentSnapshot): Promise<void> {
    const { settings, setDepth } = useAppStore.getState();
    const { transducerDepthFt, keelDepthFt } = settings;
    // Offsets are asked once; until then the numeral shows raw depth and nothing is logged.
    if (transducerDepthFt === null || keelDepthFt === null) {
      setDepth({ tMs: snap.tMs, rawFt: snap.rawDepthFt, underKeelFt: null, mllwDepthFt: null, tideFt: null, logged: false });
      return;
    }
    let tideFt: number | null = null;
    let stationId: string | null = null;
    if (snap.lat !== null && snap.lon !== null) {
      const near = nearestStation(await this.stations(), { lat: snap.lat, lon: snap.lon });
      if (near) {
        stationId = near.station.station_id;
        const series = await loadSeries(stationId); // re-reads when the daily refresh replaced the file
        tideFt = series ? interpolateTide(series, snap.tMs) : null;
      }
    }
    const corrected =
      tideFt === null
        ? null
        : correctToMllw({ rawDepthFt: snap.rawDepthFt, transducerDepthFt, keelDepthFt, tideFt });
    const verdict = this.filter.accept({
      tMs: snap.tMs, depthFt: snap.rawDepthFt, sogKt: snap.sogKt, hdop: snap.hdop, lat: snap.lat, lon: snap.lon,
    });
    const logged = verdict.ok && corrected !== null && stationId !== null && snap.lat !== null && snap.lon !== null;
    if (logged && corrected && stationId) {
      const db = await getDb();
      await db.runAsync(
        'INSERT INTO soundings (t_ms, lat, lon, raw_ft, mllw_depth_ft, tide_ft, station_id) VALUES (?,?,?,?,?,?,?)',
        snap.tMs, snap.lat as number, snap.lon as number, snap.rawDepthFt, corrected.mllwDepthFt, corrected.tideFt, stationId,
      );
    }
    // Under-keel clearance does not need the tide; show it even when tide data is missing.
    setDepth({
      tMs: snap.tMs,
      rawFt: snap.rawDepthFt,
      underKeelFt: snap.rawDepthFt + transducerDepthFt - keelDepthFt,
      mllwDepthFt: corrected?.mllwDepthFt ?? null,
      tideFt,
      logged,
    });
  }

  /**
   * Aggregate not-yet-uploaded soundings to H3-12 / UTC day and queue them.
   * Crash-safe and idempotent: the enqueue and the `aggregated` flag flip happen in ONE serialized transaction, and the
   * batch id is derived from the sounding id range + a per-install random id, so a repeat can never double count.
   */
  async aggregateAndEnqueue(): Promise<number> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: number; t_ms: number; lat: number; lon: number; mllw_depth_ft: number }>(
      'SELECT id, t_ms, lat, lon, mllw_depth_ft FROM soundings WHERE aggregated = 0 ORDER BY id',
    );
    if (rows.length === 0) return 0;
    const first = rows[0]!.id;
    const last = rows[rows.length - 1]!.id;
    const soundings: CorrectedSounding[] = rows.map((r) => ({ tMs: r.t_ms, lat: r.lat, lon: r.lon, mllwDepthFt: r.mllw_depth_ft }));
    const payload = buildUploadPayload(aggregateSoundings(soundings));
    let installId = await kvGet<string>('install.id');
    if (!installId) {
      installId = uuidv4();
      await kvSet('install.id', installId);
    }
    await runTx(async (tx) => {
      // outbox.enqueue / store.insert use the shared connection and open no transaction of their own.
      if (payload.rows.length > 0) await this.outbox.enqueue('depth_batch', payload, { id: soundingBatchId(installId as string, first, last) });
      await tx.runAsync('UPDATE soundings SET aggregated = 1 WHERE aggregated = 0 AND id BETWEEN ? AND ?', first, last);
    });
    return payload.rows.length;
  }
}
