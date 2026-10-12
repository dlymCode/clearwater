import { Camera, Map, Marker, type MapRef, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { Pressable, Text, View } from 'react-native';
import { AOI_LABELS, type AoiSlug, type TileLayer } from '@clearwater/shared';
import { Banner, NotForNavigationLine } from '../components/Banner';
import { Button } from '../components/Button';
import { DepthLegend } from '../components/DepthLegend';
import { DepthNumeral } from '../components/DepthNumeral';
import { PingDetail } from '../components/PingDetail';
import { s, useColors } from '../components/theme';
import { haversineM, isGpsStale, shouldRender } from '../lib/geo';
import { readoutFromFleetPixels, readoutFromPixels, type FleetReadout, type InspectReadout } from '../lib/inspect';
import { buildMapStyle, type LayerToggles } from '../lib/mapStyle';
import { normalizePingRow, optimisticVote, visiblePings, buildVotePayload, voteAvailability, type ScoredPing } from '../lib/pingModel';
import { canWrite } from '../lib/profile';
import { safeRegionReadout, type BoundaryCollection } from '../lib/region';
import { offsetsNeeded } from '../lib/settings';
import { aoiBanner } from '../lib/syncCursor';
import { type InstalledAoi } from '../lib/tilesIndex';
import { getInstalled, localFileUri } from '../services/downloads';
import { loadLocalPings, loadMyVotedPingIds, saveLocalVote } from '../services/localWrites';
import { loadRegions } from '../services/regions';
import { saveSettings } from '../services/settingsRepo';
import { outbox } from '../services/syncService';
import { stubTileSampler } from '../services/tileSampler';
import { useAppStore } from '../state/store';
import { InspectPopup } from './InspectPopup';
import { PingSheet } from './PingSheet';

// TODO(item 19, not implemented): group ping creation (PingSheet takes a groupId; the map always posts public), a
// remove-member UI, an "Inspect unavailable" message while tileSampler is a stub, and MAP-4 scene-count display.
const AOI: AoiSlug = 'skagit'; // TODO: persist the user's selected AOI; Skagit is the beta area
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
  const userId = useAppStore((st) => st.userId);
  const [myVotes, setMyVotes] = useState<Set<string>>(new Set());
  const mapRef = useRef<MapRef>(null);

  const [installed, setInstalled] = useState<InstalledAoi | undefined>();
  const [regions, setRegions] = useState<BoundaryCollection | null>(null);
  const [now, setNow] = useState(Date.now());
  const minute = Math.floor(now / 60_000);
  const [shownGps, setShownGps] = useState(gps);
  const lastRender = useRef(0);
  const [readout, setReadout] = useState<InspectReadout | null>(null);
  const [fleetReadout, setFleetReadout] = useState<FleetReadout | null>(null);
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
      setMyVotes(await loadMyVotedPingIds());
      // Unsynced = queued OR rejected-and-not-retried: both keep the "pending sync" mark.
      setScored(visiblePings(pings, Date.now(), await outbox.unsyncedIds('ping')));
    })();
  }, [rev, minute, userId]); // refresh on data change and once a minute (decay)

  const style = useMemo(() => {
    if (!installed) return null;
    const f = (name: string) => `${PMTILES}${localFileUri(AOI, installed.version, name)}`;
    const has = (l: TileLayer) => (installed.layers ?? []).includes(l);
    return buildMapStyle(
      {
        base: f('base.pmtiles'),
        depth: f('depth.pmtiles'),
        ...(installed.companions?.includes('depth_meta') ? { depthMeta: f('depth_meta.pmtiles') } : {}),
        // Optional products appear only when their file is on disk: a missing land / waterline / fleet never breaks the map.
        ...(installed.companions?.includes('land') ? { land: f('land.pmtiles') } : {}),
        ...(has('waterline') ? { waterline: f('waterline.pmtiles') } : {}),
        ...(has('fleet') ? { fleet: f('fleet.pmtiles') } : {}),
        ...(has('fleet') && installed.companions?.includes('fleet_meta') ? { fleetMeta: f('fleet_meta.pmtiles') } : {}),
      },
      settings.toggles,
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
      if (settings.toggles.fleet && (installed?.layers ?? []).includes('fleet')) {
        const [ft, fm] = await Promise.all([
          stubTileSampler.sample('fleet', lon, lat, zoom),
          stubTileSampler.sample('fleet_meta', lon, lat, zoom),
        ]);
        setFleetReadout(readoutFromFleetPixels(ft, fm));
      } else {
        setFleetReadout(null);
      }
      setRegionText(safeRegionReadout({ lat, lon }, regions)?.text ?? null);
    },
    [regions, installed, settings.toggles.fleet],
  );

  async function vote(pingId: string, v: 1 | -1) {
    const now = Date.now();
    await outbox.enqueue('vote', buildVotePayload(pingId, v, now));
    await saveLocalVote(optimisticVote(pingId, v, now)); // greys the buttons at once; the server row reconciles it
    setDetail(null);
    bump();
  }

  const profileReady = useAppStore((st) => st.profileReady);
  const accountRevoked = useAppStore((st) => st.accountRevoked);
  const gate = canWrite({ profileReady, accountRevoked });
  const stale = isGpsStale(shownGps?.tMs, now);
  const here = shownGps ? { lat: shownGps.lat, lon: shownGps.lon } : null;
  const banner = installed ? aoiBanner(AOI_LABELS[AOI as AoiSlug], installed.downloadedAt, now) : null;
  const liveRegion = here ? (safeRegionReadout(here, regions)?.text ?? null) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {style ? (
        <Map ref={mapRef} style={{ flex: 1 }} mapStyle={style} onPress={(e) => void onPress(e as NativeSyntheticEvent<{ lngLat: [number, number] }>)} onLongPress={(e) => setPlaced({ lat: e.nativeEvent.lngLat[1], lon: e.nativeEvent.lngLat[0] })}>
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
        {accountRevoked ? <Banner level="red" text="This account has been blocked by the server. Pings and votes are paused." /> : null}
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

      <InspectPopup readout={readout} fleet={fleetReadout} region={regionText} onClose={() => { setReadout(null); setFleetReadout(null); }} />
      <PingSheet
        visible={pingSheet}
        position={placed ?? here}
        tideFt={depth?.tideFt ?? null}
        groupId={null}
        onClose={() => { setPingSheet(false); setPlaced(null); }}
      />
      <PingDetail
        scored={detail}
        availability={detail && gate.ok ? voteAvailability({
          isOwn: !!userId && detail.ping.author_id === userId,
          pendingSync: detail.pendingSync,
          alreadyVoted: myVotes.has(detail.ping.id),
          distanceToPingM: here ? haversineM(here, { lat: detail.ping.lat, lon: detail.ping.lon }) : null,
        }) : { confirm: false, dispute: false, reason: gate.ok ? null : gate.reason }}
        onVote={(id, v) => void vote(id, v)} onClose={() => setDetail(null)} />
    </View>
  );
}
