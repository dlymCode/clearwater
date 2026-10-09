/**
 * Client-generated UUIDs for the outbox (idempotency keys). Uses the platform CSPRNG when present
 * (`crypto.randomUUID` or `crypto.getRandomValues`; on React Native load
 * `react-native-get-random-values` first, see index.ts). The Math.random fallback exists only so
 * the code never throws; it is not cryptographically strong.
 */
export type IdGenerator = () => string;

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (a: Uint8Array) => Uint8Array;
}

export const uuidv4: IdGenerator = () => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10, 16).join('')}`;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
