/**
 * BlackHole WebRTC Engine
 * Handles peer connections, candidate gathering, active path inspection (LAN vs WAN),
 * and backpressure-governed RTCDataChannels.
 */

import { logger } from './logger';

export type ConnectionMode = 'connecting' | 'lan' | 'wan' | 'relay' | 'disconnected';

export interface WebRTCEvents {
  onConnectionModeChange?: (mode: ConnectionMode) => void;
  onDataChannelOpen?: () => void;
  onDataChannelClose?: () => void;
  onDataReceived?: (data: ArrayBuffer) => void;
  onSignal?: (data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => void;
  onError?: (err: Error) => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

// 1 MB buffer ceiling, 128 KB low threshold for optimal SCTP throughput on Android & Desktop
const BUFFER_THRESHOLD = 1024 * 1024;
const BUFFER_LOW_THRESHOLD = 128 * 1024;

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private events: WebRTCEvents;
  private isSender: boolean;
  public connectionMode: ConnectionMode = 'connecting';
  public knownLocalIps: string[] = [];

  constructor(isSender: boolean, events: WebRTCEvents, knownLocalIps: string[] = []) {
    this.isSender = isSender;
    this.events = events;
    this.knownLocalIps = knownLocalIps;
  }

  public init() {
    logger.info('WEBRTC', `Initializing RTCPeerConnection (Role: ${this.isSender ? 'SENDER' : 'RECEIVER'})`);
    this.pc = new RTCPeerConnection(ICE_SERVERS);

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.events.onSignal) {
        this.events.onSignal({ candidate: event.candidate.toJSON() });

        const candStr = event.candidate.candidate;
        const candObj = event.candidate as any;
        logger.info('WEBRTC', `Generated local ICE candidate: ${event.candidate.type || 'cand'} ${event.candidate.address || candObj.ip || 'local'}:${event.candidate.port}`);

        // De-anonymize mDNS .local host candidates for devices that don't support mDNS (e.g. Android)
        if (candStr && candStr.includes('typ host') && candStr.includes('.local')) {
          for (const ip of this.knownLocalIps) {
            const deAnonymized = candStr.replace(/[\w\-]+\.local/, ip);
            logger.info('WEBRTC', `Synthesizing de-anonymized direct LAN host candidate: ${ip}`);
            this.events.onSignal({
              candidate: {
                candidate: deAnonymized,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex,
              },
            });
          }
        }
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc?.iceConnectionState;
      logger.info('WEBRTC', `ICE connection state changed -> ${iceState}`);
      if (iceState === 'connected' || iceState === 'completed') {
        this.detectConnectionMode();
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      logger.info('WEBRTC', `PeerConnection state changed -> ${state}`);

      if (state === 'connected') {
        this.detectConnectionMode();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.setMode('disconnected');
        this.events.onDataChannelClose?.();
      }
    };

    if (this.isSender) {
      // Sender creates the DataChannel
      this.dc = this.pc.createDataChannel('blackhole-transfer', {
        ordered: true,
      });
      this.setupDataChannel(this.dc);
    } else {
      // Receiver waits for DataChannel
      this.pc.ondatachannel = (event) => {
        this.dc = event.channel;
        this.setupDataChannel(this.dc);
      };
    }
  }

  private setupDataChannel(dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

    dc.onopen = () => {
      logger.success('WEBRTC', 'RTCDataChannel opened and ready for wire-speed streaming');
      this.events.onDataChannelOpen?.();
      this.detectConnectionMode();
    };

    dc.onclose = () => {
      logger.warn('WEBRTC', 'RTCDataChannel closed');
      this.events.onDataChannelClose?.();
      this.setMode('disconnected');
    };

    dc.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.events.onDataReceived?.(event.data);
      }
    };

    dc.onerror = (err) => {
      logger.error('WEBRTC', 'RTCDataChannel error encountered', err);
      this.events.onError?.(new Error('DataChannel error'));
    };
  }

  /**
   * Inspects active ICE candidate pair to detect if connection is:
   * - LAN ('host' to 'host' candidates on same local subnet)
   * - WAN ('srflx' NAT hole punch across different networks)
   * - Relay ('relay' candidate)
   */
  public async detectConnectionMode(attempt = 0) {
    if (!this.pc) return;

    try {
      const stats = await this.pc.getStats();
      let selectedPair: any = null;

      stats.forEach((report) => {
        if (
          report.type === 'candidate-pair' &&
          (report.selected || report.state === 'succeeded' || report.nominated)
        ) {
          selectedPair = report;
        }
      });

      if (selectedPair) {
        const localCandidate = stats.get(selectedPair.localCandidateId);
        const remoteCandidate = stats.get(selectedPair.remoteCandidateId);

        if (localCandidate && remoteCandidate) {
          const localType = localCandidate.candidateType;
          const remoteType = remoteCandidate.candidateType;
          const localIp = localCandidate.address || localCandidate.ip || '';
          const remoteIp = remoteCandidate.address || remoteCandidate.ip || '';

          const isLocalSubnet = (ip: string) =>
            /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip);

          logger.info('NETWORK', `Active ICE path inspection: Local ${localType}(${localIp}) <-> Remote ${remoteType}(${remoteIp})`);

          if (
            (localType === 'host' && remoteType === 'host') ||
            (isLocalSubnet(localIp) && isLocalSubnet(remoteIp))
          ) {
            logger.success('NETWORK', `Active connection is DIRECT LAN (Local Wire Speed)! Zero internet bandwidth used.`);
            logger.setActiveCandidates(`${localIp} (${localType})`, `${remoteIp} (${remoteType})`, 'Direct LAN Wire Speed');
            this.setMode('lan');
            return;
          } else if (localType === 'relay' || remoteType === 'relay') {
            logger.warn('NETWORK', `Active connection is using TURN/Relay server.`);
            logger.setActiveCandidates(`${localIp} (${localType})`, `${remoteIp} (${remoteType})`, 'Encrypted Relay');
            this.setMode('relay');
            return;
          } else {
            logger.info('NETWORK', `Active connection is WAN NAT P2P across internet.`);
            logger.setActiveCandidates(`${localIp} (${localType})`, `${remoteIp} (${remoteType})`, 'Internet WAN P2P');
            this.setMode('wan');
            return;
          }
        }
      }

      if (attempt < 3) {
        setTimeout(() => this.detectConnectionMode(attempt + 1), 600);
      } else {
        this.setMode('wan');
      }
    } catch (err) {
      console.warn('[WebRTC] Error inspecting candidate stats', err);
      if (attempt < 3) {
        setTimeout(() => this.detectConnectionMode(attempt + 1), 600);
      } else {
        this.setMode('wan');
      }
    }
  }

  private candidateQueue: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  private setMode(mode: ConnectionMode) {
    this.connectionMode = mode;
    this.events.onConnectionModeChange?.(mode);
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('PeerConnection not initialized');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  public async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) throw new Error('PeerConnection not initialized');
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushCandidateQueue();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  public async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) throw new Error('PeerConnection not initialized');
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushCandidateQueue();
  }

  public async handleCandidate(candidateInit: RTCIceCandidateInit) {
    if (!this.pc) return;
    if (!this.remoteDescriptionSet || !this.pc.remoteDescription) {
      this.candidateQueue.push(candidateInit);
      return;
    }
    await this.addCandidateInternal(candidateInit);
  }

  private async addCandidateInternal(candidateInit: RTCIceCandidateInit) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));

      // If remote peer sent a host candidate with .local, inject synthetic candidates for each known local IP
      if (candidateInit.candidate && candidateInit.candidate.includes('typ host') && candidateInit.candidate.includes('.local')) {
        for (const ip of this.knownLocalIps) {
          const deAnonymized = candidateInit.candidate.replace(/[\w\-]+\.local/, ip);
          console.log('[WebRTC LAN Synthesis] Injecting direct LAN IP route for peer:', ip);
          await this.pc.addIceCandidate(new RTCIceCandidate({
            candidate: deAnonymized,
            sdpMid: candidateInit.sdpMid,
            sdpMLineIndex: candidateInit.sdpMLineIndex,
          })).catch(() => {});
        }
      }

      // Synthesize direct LAN host candidate if STUN candidate reveals private IP in raddr
      if (candidateInit.candidate && candidateInit.candidate.includes('typ srflx')) {
        const raddrMatch = candidateInit.candidate.match(/raddr\s+(\d+\.\d+\.\d+\.\d+)/);
        const rportMatch = candidateInit.candidate.match(/rport\s+(\d+)/);
        if (raddrMatch && rportMatch) {
          const raddr = raddrMatch[1];
          const rport = rportMatch[1];
          const isPrivate = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(raddr);
          if (isPrivate) {
            const synthetic = candidateInit.candidate
              .replace(/typ srflx/, 'typ host')
              .replace(/(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+typ host/, `${raddr} ${rport} typ host`);
            
            console.log('[WebRTC LAN Synthesis] Injecting direct LAN route:', raddr, rport);
            await this.pc.addIceCandidate(new RTCIceCandidate({
              candidate: synthetic,
              sdpMid: candidateInit.sdpMid,
              sdpMLineIndex: candidateInit.sdpMLineIndex,
            })).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn('[WebRTC] Error adding ICE candidate', err);
    }
  }

  private async flushCandidateQueue() {
    while (this.candidateQueue.length > 0) {
      const candidate = this.candidateQueue.shift();
      if (candidate) {
        await this.addCandidateInternal(candidate);
      }
    }
  }

  /**
   * Sends packet over DataChannel with backpressure flow control
   */
  public async sendPacket(data: Uint8Array): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('DataChannel is not open');
    }

    // Backpressure: If buffer is full, wait for bufferedamountlow event or drain
    if (this.dc.bufferedAmount > BUFFER_THRESHOLD) {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        let lastBuffered = this.dc?.bufferedAmount || 0;
        let lastProgressTime = Date.now();

        const finish = () => {
          if (!done) {
            done = true;
            cleanup();
            resolve();
          }
        };

        const fail = (err: Error) => {
          if (!done) {
            done = true;
            cleanup();
            reject(err);
          }
        };

        const onLow = () => finish();
        this.dc?.addEventListener('bufferedamountlow', onLow, { once: true });

        const poll = setInterval(() => {
          // Check if socket died mid-transfer
          if (
            !this.dc ||
            this.dc.readyState !== 'open' ||
            this.pc?.connectionState === 'disconnected' ||
            this.pc?.connectionState === 'failed' ||
            this.pc?.iceConnectionState === 'disconnected' ||
            this.pc?.iceConnectionState === 'failed'
          ) {
            fail(new Error('WebRTC socket disconnected mid-transfer'));
            return;
          }

          const currentBuffered = this.dc.bufferedAmount;
          if (currentBuffered <= BUFFER_LOW_THRESHOLD) {
            finish();
            return;
          }

          // If buffer is actively draining over Wi-Fi, reset the stall timer!
          if (currentBuffered < lastBuffered) {
            lastBuffered = currentBuffered;
            lastProgressTime = Date.now();
          }

          // Timeout only if buffer is completely frozen for 10s without draining
          if (Date.now() - lastProgressTime > 10000) {
            fail(new Error('WebRTC buffer drain timeout (socket stalled)'));
          }
        }, 15);

        const cleanup = () => {
          clearInterval(poll);
          this.dc?.removeEventListener('bufferedamountlow', onLow);
        };
      });
    }

    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('DataChannel closed during transfer');
    }

    try {
      (this.dc as any).send(data);
    } catch (err: any) {
      throw new Error(`DataChannel send failed: ${err?.message || err}`);
    }
  }

  public getDataChannel(): RTCDataChannel | null {
    return this.dc;
  }

  public close() {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.setMode('disconnected');
  }
}
