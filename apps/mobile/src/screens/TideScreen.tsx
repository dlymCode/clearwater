import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { TIDE_CURVE_WINDOW_HOURS } from '@clearwater/shared';
import { Banner } from '../components/Banner';
import { s, useColors } from '../components/theme';
import { REFERENCE_TIDE_STATIONS } from '../lib/stations';
import { isTideStale } from '../lib/syncCursor';
import { daysCachedAhead, interpolateTide, nearestStation, tideCurve, type TideSeries } from '../lib/tide';
import { loadSeries, tideFetchedAt } from '../services/tideService';
import { useAppStore } from '../state/store';

/** MAP-8: 48 h curve (24 h back, 24 h ahead) for the nearest station, current height marked. Reads the local cache only (works offline). */
export function TideScreen() {
  const c = useColors();
  const gps = useAppStore((st) => st.gps);
  const near = useMemo(
    () => nearestStation(REFERENCE_TIDE_STATIONS, gps ? { lat: gps.lat, lon: gps.lon } : { lat: 48.3, lon: -122.5 }),
    [gps],
  );
  const [series, setSeries] = useState<TideSeries | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!near) return;
    void loadSeries(near.station.station_id).then(setSeries);
    void tideFetchedAt(near.station.station_id).then(setFetchedAt);
  }, [near]);

  const half = (TIDE_CURVE_WINDOW_HOURS / 2) * 3_600_000;
  const curve = useMemo(() => (series ? tideCurve(series, now - half, now + half, 30) : []), [series, now, half]);
  const heights = curve.map((p) => p.v).filter((v): v is number => v !== null);
  const min = Math.min(0, ...heights);
  const max = Math.max(1, ...heights);
  const current = series ? interpolateTide(series, now) : null;
  const nowIndex = Math.round(half / (30 * 60_000));

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>{near ? near.station.name : 'Tides'}</Text>
      {near ? <Text style={[s.small, { color: c.sub }]}>{`Station ${near.station.station_id}, ${(near.distanceM / 1000).toFixed(0)} km away`}</Text> : null}
      {!series ? <Banner level="red" text="No tide predictions cached for this station. Connect to WiFi to download." /> : null}
      {series && isTideStale(fetchedAt, now) ? <Banner level="yellow" text="Tide predictions are more than 24 h old." /> : null}
      {series ? <Text style={[s.small, { color: c.sub }]}>{`${daysCachedAhead(series, now).toFixed(0)} days of predictions cached`}</Text> : null}
      <Text style={{ fontSize: 56, fontWeight: '800', color: c.text }}>{current === null ? '--' : `${current.toFixed(1)} ft`}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 160, gap: 1 }} accessibilityLabel="48 hour tide curve">
        {curve.map((p, i) => (
          <View
            key={p.tMs}
            style={{
              flex: 1,
              height: p.v === null ? 2 : Math.max(2, ((p.v - min) / (max - min)) * 160),
              backgroundColor: i === nowIndex ? c.danger : p.v === null ? c.border : c.accent,
              opacity: i === nowIndex ? 1 : 0.7,
            }}
          />
        ))}
      </View>
      <Text style={[s.small, { color: c.sub }]}>Height above MLLW. Red bar = now. Times in your device zone.</Text>
    </ScrollView>
  );
}
