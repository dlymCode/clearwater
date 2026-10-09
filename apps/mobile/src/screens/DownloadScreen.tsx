import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { AOI_LABELS, type AoiSlug, type TileLayer, type TilesIndex } from '@clearwater/shared';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { aoiBanner } from '../lib/syncCursor';
import { availableLayers, downloadSizeBytes, formatBytes, latestByAoi, type InstalledAoi } from '../lib/tilesIndex';
import { getInstalled, runDownload, type DownloadProgress } from '../services/downloads';
import { kvGet } from '../services/db';
import { pullTilesIndex } from '../services/syncService';

/** MAP-9: pick an AOI, SEE THE SIZE BEFORE CONFIRMING, resumable download. Works from the cached index offline. */
export function DownloadScreen() {
  const c = useColors();
  const [index, setIndex] = useState<TilesIndex | null>(null);
  const [installed, setInstalled] = useState<Record<string, InstalledAoi | undefined>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const idx = await kvGet<TilesIndex>('tiles.index');
    setIndex(idx);
    const next: Record<string, InstalledAoi | undefined> = {};
    for (const a of idx?.aois ?? []) next[a.aoi] = await getInstalled(a.aoi);
    setInstalled(next);
  }, []);
  useEffect(() => void load(), [load]);

  const latest = index ? latestByAoi(index) : new Map();
  const entry = selected ? latest.get(selected) : undefined;
  const layers: TileLayer[] = entry ? availableLayers(entry) : [];
  const bytes = entry ? downloadSizeBytes(entry, layers, installed[entry.aoi]) : 0;

  async function start() {
    if (!entry) return;
    setStatus('Downloading...');
    const r = await runDownload(entry, layers, setProgress);
    setStatus(r === 'done' ? 'Downloaded.' : r === 'failed' ? 'Interrupted. Tap Download to resume.' : 'Cancelled.');
    await load();
  }

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Offline areas</Text>
      <Button label="Check for updates" kind="secondary" onPress={() => void pullTilesIndex().then(load)} />
      {!index ? <Banner level="info" text="No area list yet. Connect to WiFi and tap Check for updates." /> : null}
      {[...latest.values()].map((e) => {
        const inst = installed[e.aoi];
        const banner = inst ? aoiBanner(AOI_LABELS[e.aoi as AoiSlug] ?? e.aoi, inst.downloadedAt, Date.now()) : null;
        const upToDate = inst?.version === e.version;
        return (
          <View key={e.aoi} style={[s.card, s.gap, { backgroundColor: c.card, borderColor: selected === e.aoi ? c.accent : c.border }]}>
            <Text style={[s.h2, { color: c.text }]}>{AOI_LABELS[e.aoi as AoiSlug] ?? e.aoi}</Text>
            <Text style={[s.small, { color: c.sub }]}>
              {inst ? (upToDate ? 'Downloaded, up to date' : 'Downloaded, newer version available') : 'Not downloaded'}
            </Text>
            {banner ? <Banner level={banner.level} text={banner.message} /> : null}
            <Button label={selected === e.aoi ? 'Selected' : 'Select'} kind="secondary" onPress={() => setSelected(e.aoi)} />
          </View>
        );
      })}
      {entry ? (
        <View style={[s.card, s.gap, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[s.h2, { color: c.text }]}>{`Download size: ${bytes === 0 ? 'nothing new' : formatBytes(bytes)}`}</Text>
          <Text style={[s.small, { color: c.sub }]}>{`Layers: ${layers.join(', ')} (+ a small depth metadata file). Wi-Fi recommended.`}</Text>
          {progress ? <Text style={[s.body, { color: c.text }]}>{`${Math.round(progress.fraction * 100)}% (${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)})`}</Text> : null}
          {status ? <Text style={[s.body, { color: c.text }]}>{status}</Text> : null}
          <Button label={bytes === 0 ? 'Up to date' : 'Download'} disabled={bytes === 0} onPress={() => void start()} />
        </View>
      ) : null}
    </ScrollView>
  );
}
