/**
 * NMEA 0183 socket client: TCP (react-native-tcp-socket) or UDP (react-native-udp) from a WiFi gateway
 * (Yacht Devices YDWG-02 / Actisense W2K-1). Incoming bytes are buffered and parsed ONCE PER SECOND
 * (battery: PRD §Battery). All parsing/validation is in lib/nmea.ts.
 */
import TcpSocket from 'react-native-tcp-socket';
import dgram from 'react-native-udp';
import { NmeaFixTracker, NmeaStream, type InstrumentSnapshot, type NmeaStats } from '../lib/nmea';
import type { NmeaProtocol } from '../lib/settings';

export type NmeaStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface NmeaClientHandlers {
  onSnapshot: (s: InstrumentSnapshot) => void;
  onStatus?: (status: NmeaStatus, detail?: string) => void;
  onStats?: (stats: NmeaStats) => void;
}

export interface NmeaEndpoint {
  host: string;
  port: number;
  protocol: NmeaProtocol;
}

const FLUSH_MS = 1000;
const RECONNECT_MS = 5000;

const asText = (data: unknown): string =>
  typeof data === 'string' ? data : (data as { toString(enc: string): string }).toString('utf8');

export class NmeaClient {
  private stream = new NmeaStream();
  private tracker = new NmeaFixTracker();
  private pending: Array<{ text: string; endsDatagram: boolean }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tcp: ReturnType<typeof TcpSocket.createConnection> | null = null;
  private udp: ReturnType<typeof dgram.createSocket> | null = null;
  private running = false;
  private endpoint: NmeaEndpoint | null = null;

  constructor(private readonly handlers: NmeaClientHandlers) {}

  start(endpoint: NmeaEndpoint): void {
    this.stop();
    this.running = true;
    this.endpoint = endpoint;
    this.stream = new NmeaStream();
    this.tracker = new NmeaFixTracker();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.flushTimer = this.reconnectTimer = null;
    this.tcp?.destroy();
    this.tcp = null;
    try {
      this.udp?.close();
    } catch {
      /* already closed */
    }
    this.udp = null;
    this.pending = [];
    this.handlers.onStatus?.('idle');
  }

  private connect(): void {
    const ep = this.endpoint;
    if (!ep || !this.running) return;
    this.handlers.onStatus?.('connecting');
    if (ep.protocol === 'tcp') {
      const socket = TcpSocket.createConnection({ host: ep.host, port: ep.port }, () => this.handlers.onStatus?.('connected'));
      this.tcp = socket;
      socket.on('data', (d: unknown) => this.pending.push({ text: asText(d), endsDatagram: false }));
      socket.on('error', (e: unknown) => this.handlers.onStatus?.('error', e instanceof Error ? e.message : String(e)));
      socket.on('close', () => {
        this.handlers.onStatus?.('disconnected');
        this.scheduleReconnect();
      });
    } else {
      const socket = dgram.createSocket({ type: 'udp4', reusePort: true });
      this.udp = socket;
      socket.on('message', (msg: unknown) => this.pending.push({ text: asText(msg), endsDatagram: true }));
      socket.on('error', (e: unknown) => this.handlers.onStatus?.('error', e instanceof Error ? e.message : String(e)));
      // UDP is connectionless: listen on the configured port for gateway broadcasts/unicast.
      socket.bind(ep.port, (err?: Error) => {
        if (err) this.handlers.onStatus?.('error', err.message);
        else this.handlers.onStatus?.('connected');
      });
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  /** Called every second: parse everything buffered since the last call. */
  private flush(): void {
    if (this.pending.length === 0) return;
    const chunks = this.pending;
    this.pending = [];
    const now = Date.now();
    for (const c of chunks) {
      for (const s of this.stream.feed(c.text, c.endsDatagram)) {
        const snap = this.tracker.update(s, now);
        if (snap) this.handlers.onSnapshot(snap);
      }
    }
    this.handlers.onStats?.({ ...this.stream.stats });
  }
}
