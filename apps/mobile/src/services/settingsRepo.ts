import type { AppSettings } from '../lib/settings';
import { useAppStore } from '../state/store';
import { kvGet, kvSet } from './db';

const KEY = 'settings.v1';

export async function loadSettings(): Promise<void> {
  useAppStore.getState().hydrateSettings(await kvGet<unknown>(KEY));
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  useAppStore.getState().setSettings(patch);
  await kvSet(KEY, useAppStore.getState().settings);
}
