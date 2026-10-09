/**
 * Passive depth logger: NMEA snapshot -> physical filters -> offset + tide correction -> SQLCipher store
 * -> (periodically) H3/day aggregation -> outbox depth_batch. Raw soundings never leave the device.
 */
import { useAppStore } from '../state/store';
import { aggregateSoundings, buildUploadPayload, type CorrectedSounding } from '../lib/aggregate';
import { DepthFilter } from '../lib/depthFilter';
import type { InstrumentSnapshot } from '../lib/nmea';
import type { Outbox } from '../lib/outbox';
import { correctToMllw, interpolateTide, nearestStation, type TideSeries } from '../lib/tide';
import { REFERENCE_TIDE_STATIONS } from '../lib/stations';
import { getDb } from './db';
import { loadSeries } from './tideService';

const AGGREGATE_EVERY_MS = 10 * 60 * 1000;

export class DepthLogger {
  private filter = new DepthFilter();
  private series = new Map<string, TideSeries>();
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

  private async seriesFor(stationId: string): Promise<TideSeries | null> {
    const cached = this.series.get(stationId);
    if (cached) return cached;
    const s = await loadSeries(stationId);
    if (s) this.series.set(stationId, s);
    return s;
  }

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
      const near = nearestStation(REFERENCE_TIDE_STATIONS, { lat: snap.lat, lon: snap.lon });
      if (near) {
        stationId = near.station.station_id;
        const series = await this.seriesFor(stationId);
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

  /** Aggregate not-yet-uploaded soundings to H3-12 / UTC day and queue them. */
  async aggregateAndEnqueue(): Promise<number> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: number; t_ms: number; lat: number; lon: number; mllw_depth_ft: number }>(
      'SELECT id, t_ms, lat, lon, mllw_depth_ft FROM soundings WHERE aggregated = 0 ORDER BY id',
    );
    if (rows.length === 0) return 0;
    const soundings: CorrectedSounding[] = rows.map((r) => ({ tMs: r.t_ms, lat: r.lat, lon: r.lon, mllwDepthFt: r.mllw_depth_ft }));
    const agg = aggregateSoundings(soundings);
    const payload = buildUploadPayload(agg);
    await db.withTransactionAsync(async () => {
      if (payload.rows.length > 0) await this.outbox.enqueue('depth_batch', payload);
      await db.runAsync(`UPDATE soundings SET aggregated = 1 WHERE id <= ?`, rows[rows.length - 1]!.id);
    });
    return payload.rows.length;
  }
}
