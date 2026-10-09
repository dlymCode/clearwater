/**
 * Device GPS at 1 Hz (MAP-5). `Balanced` accuracy while the sounder feed is active (battery), `Lowest`
 * otherwise. Updates are forwarded unthrottled; the UI throttles map re-renders to 2 Hz (lib/geo shouldRender).
 */
import * as Location from 'expo-location';

export interface GpsFix {
  tMs: number;
  lat: number;
  lon: number;
  /** m/s -> knots already applied. null when the platform reports no speed. */
  sogKt: number | null;
  cogDeg: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
}

const MS_TO_KT = 1.943844492;

export async function requestForegroundPermission(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === Location.PermissionStatus.GRANTED;
}

export async function watchGps(
  sounderActive: boolean,
  onFix: (fix: GpsFix) => void,
): Promise<Location.LocationSubscription> {
  return Location.watchPositionAsync(
    {
      accuracy: sounderActive ? Location.Accuracy.Balanced : Location.Accuracy.Lowest,
      timeInterval: 1000,
      distanceInterval: 0,
    },
    (loc) => {
      const c = loc.coords;
      onFix({
        tMs: loc.timestamp,
        lat: c.latitude,
        lon: c.longitude,
        sogKt: c.speed !== null && c.speed >= 0 ? c.speed * MS_TO_KT : null,
        cogDeg: c.heading !== null && c.heading >= 0 ? c.heading : null,
        headingDeg: c.heading !== null && c.heading >= 0 ? c.heading : null,
        accuracyM: c.accuracy,
      });
    },
  );
}
