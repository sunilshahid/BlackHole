/**
 * BlackHole Development Diagnostics & Logging Engine
 * Tracks comprehensive end-to-end metrics across WebRTC, ICE candidates,
 * active network paths, transfer speeds, buffer backpressure, and crypto engines.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export type LogCategory = 'WEBRTC' | 'NETWORK' | 'CRYPTO' | 'SPEED' | 'STREAM' | 'SYSTEM';

export interface LogEntry {
  id: string;
  timestamp: string; // HH:MM:SS.mmm
  epoch: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: any;
}

export interface DiagnosticsState {
  role: 'sender' | 'receiver' | 'unknown';
  roomCode: string;
  connectionMode: string;
  activeLocalCandidate?: string;
  activeRemoteCandidate?: string;
  activeCandidateType?: string;
  cipher: string;
  hardwareCryptoAvailable: boolean;
  currentSpeedBytesPerSec: number;
  averageSpeedBytesPerSec: number;
  totalBytesTransferred: number;
  dataChannelBufferedAmount: number;
  lastError?: string;
}

type LogListener = (entry: LogEntry, allLogs: LogEntry[]) => void;
type StateListener = (state: DiagnosticsState) => void;

class DiagnosticsLogger {
  private logs: LogEntry[] = [];
  private maxLogs = 600;
  private logListeners: Set<LogListener> = new Set();
  private stateListeners: Set<StateListener> = new Set();

  public state: DiagnosticsState = {
    role: 'unknown',
    roomCode: '',
    connectionMode: 'disconnected',
    cipher: 'detecting...',
    hardwareCryptoAvailable: typeof window !== 'undefined' && !!window.crypto?.subtle,
    currentSpeedBytesPerSec: 0,
    averageSpeedBytesPerSec: 0,
    totalBytesTransferred: 0,
    dataChannelBufferedAmount: 0,
  };

  constructor() {
    this.info('SYSTEM', 'Diagnostics logger initialized', {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
      hardwareSubtleCrypto: this.state.hardwareCryptoAvailable,
    });
  }

  public setSession(role: 'sender' | 'receiver', roomCode: string, _ws?: WebSocket) {
    this.state.role = role;
    this.state.roomCode = roomCode;
    this.notifyState();
    this.info('SYSTEM', `Session established: ${role.toUpperCase()} in Room [${roomCode}]`);
  }

  public setConnectionMode(mode: string) {
    this.state.connectionMode = mode;
    this.notifyState();
  }

  public setCipher(cipher: string) {
    this.state.cipher = cipher;
    this.notifyState();
  }

  public setActiveCandidates(local: string, remote: string, type: string) {
    this.state.activeLocalCandidate = local;
    this.state.activeRemoteCandidate = remote;
    this.state.activeCandidateType = type;
    this.notifyState();
  }

  public updateSpeed(instantSpeed: number, rollingSpeed: number, transferred: number, bufferAmount = 0) {
    this.state.currentSpeedBytesPerSec = instantSpeed;
    this.state.averageSpeedBytesPerSec = rollingSpeed;
    this.state.totalBytesTransferred = transferred;
    this.state.dataChannelBufferedAmount = bufferAmount;
    this.notifyState();
  }

  public log(level: LogLevel, category: LogCategory, message: string, details?: any) {
    const now = new Date();
    const timeStr = `${now.toTimeString().split(' ')[0]}.${now.getMilliseconds().toString().padStart(3, '0')}`;

    const entry: LogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: timeStr,
      epoch: now.getTime(),
      level,
      category,
      message,
      details,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output for local dev tools / terminal forwarding
    const prefix = `[${timeStr}][${category}] ${message}`;
    if (level === 'error') {
      console.error(prefix, details || '');
      this.state.lastError = message;
      this.notifyState();
    } else if (level === 'warn') {
      console.warn(prefix, details || '');
    } else {
      console.log(prefix, details || '');
    }

    this.logListeners.forEach((fn) => fn(entry, this.logs));
  }

  public info(category: LogCategory, message: string, details?: any) {
    this.log('info', category, message, details);
  }

  public success(category: LogCategory, message: string, details?: any) {
    this.log('success', category, message, details);
  }

  public warn(category: LogCategory, message: string, details?: any) {
    this.log('warn', category, message, details);
  }

  public error(category: LogCategory, message: string, details?: any) {
    this.log('error', category, message, details);
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public clear() {
    this.logs = [];
    this.logListeners.forEach((fn) => fn({
      id: 'clear',
      timestamp: '',
      epoch: Date.now(),
      level: 'info',
      category: 'SYSTEM',
      message: 'Logs cleared',
    }, []));
  }

  public subscribeLogs(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  public subscribeState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  private notifyState() {
    this.stateListeners.forEach((fn) => fn({ ...this.state }));
  }

  public exportText(): string {
    const header = [
      `====================================================`,
      `BLACKHOLE DEV DIAGNOSTICS LOG`,
      `Exported: ${new Date().toISOString()}`,
      `Role: ${this.state.role.toUpperCase()} | Room: ${this.state.roomCode || 'N/A'}`,
      `Connection: ${this.state.connectionMode.toUpperCase()}`,
      `Active Path: ${this.state.activeCandidateType || 'N/A'}`,
      `Local: ${this.state.activeLocalCandidate || 'N/A'}`,
      `Remote: ${this.state.activeRemoteCandidate || 'N/A'}`,
      `Cipher: ${this.state.cipher} (Hardware Subtle: ${this.state.hardwareCryptoAvailable ? 'YES' : 'NO'})`,
      `Speed: ${(this.state.averageSpeedBytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`,
      `====================================================\n`,
    ].join('\n');

    const lines = this.logs.map((l) => {
      const details = l.details ? ` | ${typeof l.details === 'object' ? JSON.stringify(l.details) : l.details}` : '';
      return `[${l.timestamp}] [${l.level.toUpperCase()}] [${l.category}] ${l.message}${details}`;
    });

    return header + lines.join('\n');
  }
}

export const logger = new DiagnosticsLogger();
