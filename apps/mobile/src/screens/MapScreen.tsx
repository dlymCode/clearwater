import { Camera, Images, Map, Marker, type MapRef, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { Pressable, Text, View } from 'react-native';
import type { PingVote, TileLayer } from '@clearwater/shared';
import { Banner, NotForNavigationLine } from '../components/Banner';
import { Button } from '../components/Button';
import { DepthLegend } from '../components/DepthLegend';
import { DepthNumeral } from '../components/DepthNumeral';
import { PingDetail } from '../components/PingDetail';
import { s, useColors } from '../components/theme';
import { isGpsStale, shouldRender } from '../lib/geo';
import { readoutFromPixels, type InspectReadout } from '../lib/inspect';
import { buildMapStyle, type LayerToggles } from '../lib/mapStyle';
import { normalizePingRow, visiblePings, buildVotePayload, type ScoredPing } from '../lib/pingModel';
import { regionReadout, type BoundaryCollection } from '../lib/region';
import { offsetsNeeded } from '../lib/settings';
import { aoiBanner } from '../lib/syncCursor';
import { type InstalledAoi } from '../lib/tilesIndex';
import { getInstalled, localFileUri } from '../services/downloads';
import { loadLocalPings, loadLocalVotes } from '../services/localWrites';
import { loadRegions } from '../services/regions';
import { saveSettings } from '../services/settingsRepo';
import { outbox } from '../services/syncService';
import { stubTileSampler } from '../services/tileSampler';
import { useAppStore } from '../state/store';
import { InspectPopup } from './InspectPopup';
import { PingSheet } from './PingSheet';

const AOI = 'skagit'; // TODO: persist the user's selected AOI; Skagit is the beta area
const PMTILES = 'pmtiles://';

const TOGGLE_LABELS: Array<[keyof LayerToggles, string]> = [
  ['depth', 'Depth'], ['hillshade', 'Relief'], ['waterline', 'Waterline'], ['fleet', 'Fleet'], ['boundaries', 'Regions'],
];

/**
 * Main map. Native-only (MapLibre RN + PMTiles); NOT unit-tested. Every decision here is delegated to src/lib:
 *  style/toggles/hatching (mapStyle), stale dot (geo.isGpsStale), 2 Hz render throttle (geo.shouldRender),
 *  ping decay/visibility (pingModel + score), inspect readout (inspect + terrainRgb), region readout (region).
 */
export function MapScreen() {
  const c = useColors();
  const settings = useAppStore((st) => st.settings);
  const gps = useAppStore((st) => st.gps);
  const depth = useAppStore((st) => st.depth);
  const rev = useAppStore((st) => st.dataRev);
  const bump = useAppStore((st) => st.bumpData);
  const mapRef = useRef<MapRef>(null);

  const [installed, setInstalled] = useState<InstalledAoi | undefined>();
  const [regions, setRegions] = useState<BoundaryCollection | null>(null);
  const [now, setNow] = useState(Date.now());
  const minute = Math.floor(now / 60_000);
  const [shownGps, setShownGps] = useState(gps);
  const lastRender = useRef(0);
  const [readout, setReadout] = useState<InspectReadout | null>(null);
  const [regionText, setRegionText] = useState<string | null>(null);
  const [pingSheet, setPingSheet] = useState(false);
  const [placed, setPlaced] = useState<{ lat: number; lon: number } | null>(null);
  const [scored, setScored] = useState<ScoredPing[]>([]);
  const [detail, setDetail] = useState<ScoredPing | null>(null);

  useEffect(() => {
    void getInstalled(AOI).then((inst) => {
      setInstalled(inst);
      if (inst) void loadRegions(AOI, inst.version).then(setRegions);
    });
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Map re-render throttle: 2 Hz max for GPS-driven updates.
  useEffect(() => {
    if (gps && shouldRender(lastRender.current, Date.now())) {
      lastRender.current = Date.now();
      setShownGps(gps);
    }
  }, [gps]);

  // Pings: scored client-side from timestamps, so decay works offline.
  useEffect(() => {
    void (async () => {
      const pings = (await loadLocalPings()).map(normalizePingRow).flatMap((p) => (p ? [p] : []));
      const votes = new globalThis.Map<string, PingVote[]>();
      for (const v of await loadLocalVotes()) {
        const pv = v as unknown as PingVote;
        votes.set(pv.ping_id, [...(votes.get(pv.ping_id) ?? []), pv]);
      }
      setScored(visiblePings(pings, votes, Date.now(), await outbox.pendingIds('ping')));
    })();
  }, [rev, minute]); // refresh on data change and once a minute (decay)

  const style = useMemo(() => {
    if (!installed) return null;
    const f = (name: string) => `${PMTILES}${localFileUri(AOI, installed.version, name)}`;
    const has = (l: TileLayer) => (installed.layers ?? []).includes(l);
    return buildMapStyle(
      {
        base: f('base.pmtiles'),
        depth: f('depth.pmtiles'),
        depthMeta: f('depth_meta.pmtiles'),
        ...(has('waterline') ? { waterline: f('waterline.pmtiles') } : {}),
        ...(has('fleet') ? { fleet: f('fleet.pmtiles') } : {}),
      },
      settings.toggles,
      { hatchImage: 'hatch' },
    ) as unknown as StyleSpecification;
  }, [installed, settings.toggles]);

  const onPress = useCallback(
    async (e: NativeSyntheticEvent<{ lngLat: [number, number] }>) => {
      const [lon, lat] = e.nativeEvent.lngLat;
      const zoom = (await mapRef.current?.getZoom()) ?? 12;
      const [terrain, meta] = await Promise.all([
        stubTileSampler.sample('depth', lon, lat, zoom),
        stubTileSampler.sample('depth_meta', lon, lat, zoom),
      ]);
      setReadout(readoutFromPixels(terrain, meta, Date.now()));
      setRegionText(regions ? regionReadout({ lat, lon }, regions).text : null);
    },
    [regions],
  );

  async function vote(pingId: string, v: 1 | -1) {
    await outbox.enqueue('vote', buildVotePayload(pingId, v, Date.now()));
    setDetail(null);
    bump();
  }

  const stale = isGpsStale(shownGps?.tMs, now);
  const here = shownGps ? { lat: shownGps.lat, lon: shownGps.lon } : null;
  const banner = installed ? aoiBanner('Skagit Bay and flats', installed.downloadedAt, now) : null;
  const liveRegion = here && regions ? regionReadout(here, regions).text : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {style ? (
        <Map ref={mapRef} style={{ flex: 1 }} mapStyle={style} onPress={(e) => void onPress(e as NativeSyntheticEvent<{ lngLat: [number, number] }>)} onLongPress={(e) => setPlaced({ lat: e.nativeEvent.lngLat[1], lon: e.nativeEvent.lngLat[0] })}>
          <Images images={{ hatch: require('../../assets/hatch.png') }} />
          <Camera initialViewState={{ center: [-122.45, 48.3], zoom: 11 }} minZoom={8} maxZoom={16} />
          {shownGps ? (
            <Marker id="me" lngLat={[shownGps.lon, shownGps.lat]}>
              <View accessibilityLabel={stale ? 'Position stale' : 'Your position'} style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#fff', backgroundColor: stale ? '#8b949e' : c.accent }} />
            </Marker>
          ) : null}
          {scored.map((sp) => (
            <Marker key={sp.ping.id} id={`ping-${sp.ping.id}`} lngLat={[sp.ping.lon, sp.ping.lat]}>
              <Pressable onPress={() => setDetail(sp)} accessibilityLabel={`Ping ${sp.ping.type}`} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.danger, opacity: sp.summary.state === 'faded' ? 0.4 : 1, borderWidth: sp.summary.state === 'solid' ? 4 : 1, borderColor: '#fff', borderStyle: sp.pendingSync ? 'dashed' : 'solid', alignItems: 'center', justifyContent: 'center' }}>
                {sp.summary.state === 'solid' ? <Text style={{ color: '#fff', fontWeight: '700' }}>{sp.summary.confirms}</Text> : null}
              </Pressable>
            </Marker>
          ))}
          {placed ? (
            <Marker id="placed" lngLat={[placed.lon, placed.lat]}>
              <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 3, borderColor: c.danger, backgroundColor: '#fff8' }} />
            </Marker>
          ) : null}
        </Map>
      ) : (
        <View style={[s.fill, s.pad, s.gap, { justifyContent: 'center' }]}>
          <Banner level="info" text="No offline area on this device yet. Open Areas, pick the Skagit area and download it on WiFi." />
        </View>
      )}

      {/* Overlays */}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 8, left: 8, right: 8, gap: 6 }}>
        {banner ? <Banner level={banner.level} text={banner.message} /> : null}
        <DepthNumeral depth={depth} nowMs={now} offsetsMissing={offsetsNeeded(settings)} />
        <Text style={[s.h2, { color: c.text, textAlign: 'center', backgroundColor: c.card + 'cc' }]}>{liveRegion ?? ''}</Text>
      </View>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 8, bottom: 70 }}>
        <DepthLegend />
      </View>
      <View style={{ position: 'absolute', right: 8, top: 190, gap: 6 }}>
        {TOGGLE_LABELS.map(([key, label]) => (
          <Pressable key={key} onPress={() => void saveSettings({ toggles: { ...settings.toggles, [key]: !settings.toggles[key] } })} accessibilityRole="switch" accessibilityState={{ checked: settings.toggles[key] }} style={[s.btn, { backgroundColor: settings.toggles[key] ? c.accent : c.card, minHeight: 44 }]}>
            <Text style={{ color: settings.toggles[key] ? '#fff' : c.text, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ position: 'absolute', right: 8, bottom: 70 }}>
        <Button label="Ping" kind="danger" onPress={() => setPingSheet(true)} />
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 4 }}>
        <NotForNavigationLine />
      </View>

      <InspectPopup readout={readout} region={regionText} onClose={() => setReadout(null)} />
      <PingSheet
        visible={pingSheet}
        position={placed ?? here}
        tideFt={depth?.tideFt ?? null}
        groupId={null}
        onClose={() => { setPingSheet(false); setPlaced(null); }}
      />
      <PingDetail scored={detail} onVote={(id, v) => void vote(id, v)} onClose={() => setDetail(null)} />
    </View>
  );
}
