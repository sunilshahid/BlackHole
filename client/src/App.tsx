import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Download,
  Share2,
  File as FileIcon,
  X,
  QrCode,
  Copy,
  Check,
  ShieldCheck,
  Zap,
  Globe,
  RefreshCw,
  ArrowRight,
  Camera,
} from 'lucide-react';
import { WebRTCManager, type ConnectionMode } from './lib/webrtc';
import { deriveKeyFromSecret } from './lib/crypto';
import {
  sendFiles,
  FileReceiver,
  type TransferProgress,
  type ReceivedFile,
  type PacketTransport,
  formatBytes,
} from './lib/streaming';
import { decodePacket, encodeControlPacket } from './lib/protocol';
import { TransferProgressView } from './components/TransferProgressView';
import { QRCodeModal } from './components/QRCodeModal';
import { QRScannerModal } from './components/QRScannerModal';
import { BlackHoleLogo } from './components/BlackHoleLogo';
import { logger } from './lib/logger';

export function App() {
  const [activeTab, setActiveTab] = useState<'send' | 'receive'>('send');

  // Sender state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [senderCode, setSenderCode] = useState<string>('');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [discoveredLocalIps, setDiscoveredLocalIps] = useState<string[]>([]);
  const [isQrOpen, setIsQrOpen] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Receiver state
  const [inputCode, setInputCode] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isScannerOpen, setIsScannerOpen] = useState<boolean>(false);

  // Transfer & Connection state
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('disconnected');
  const [isTransferring, setIsTransferring] = useState<boolean>(false);
  const [isComplete, setIsComplete] = useState<boolean>(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // References
  const wsRef = useRef<WebSocket | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cancelTransferRef = useRef<boolean>(false);
  const isTransferringRef = useRef<boolean>(false);
  const isCompleteRef = useRef<boolean>(false);
  const connectionModeRef = useRef<ConnectionMode>('disconnected');
  const relayFallbackTimeoutRef = useRef<any>(null);
  const receiverEngineRef = useRef<FileReceiver | null>(null);
  const p2pEstablishedRef = useRef<boolean>(false);

  useEffect(() => {
    connectionModeRef.current = connectionMode;
    logger.setConnectionMode(connectionMode);
  }, [connectionMode]);

  useEffect(() => {
    isTransferringRef.current = isTransferring;
  }, [isTransferring]);

  useEffect(() => {
    isCompleteRef.current = isComplete;
  }, [isComplete]);

  const getWsUrl = () => {
    const envWsUrl = (import.meta as any).env?.VITE_WS_URL;
    if (envWsUrl) return envWsUrl;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  };

  // Check URL parameters on mount (for QR scan or direct link)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const codeFromQuery = urlParams.get('code');
    const hash = window.location.hash.replace('#', '');
    const codeFromHash = hash.startsWith('code=') ? hash.split('=')[1] : null;

    const initialCode = codeFromQuery || codeFromHash;
    if (initialCode) {
      const formatted = initialCode.toUpperCase().trim();
      setInputCode(formatted);
      setActiveTab('receive');
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(relayFallbackTimeoutRef.current);
      wsRef.current?.close();
      webrtcRef.current?.close();
    };
  }, []);

  /**
   * Reset session
   */
  const resetSession = () => {
    clearTimeout(relayFallbackTimeoutRef.current);
    relayFallbackTimeoutRef.current = null;
    p2pEstablishedRef.current = false;
    isTransferringRef.current = false;
    isCompleteRef.current = false;
    wsRef.current?.close();
    webrtcRef.current?.close();
    wsRef.current = null;
    webrtcRef.current = null;
    receiverEngineRef.current = null;
    setConnectionMode('disconnected');
    setIsConnecting(false);
    setIsTransferring(false);
    setIsComplete(false);
    setProgress(null);
    setSenderCode('');
    setShareUrl('');
    setErrorMessage('');
    setStatusMessage('');
    setSelectedFiles([]); // Clear previous files on sender
    setReceivedFiles([]); // Clear received files on receiver
    setInputCode(''); // Clear 6-character code input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    // Clean ?code= from browser URL bar without page refresh
    try {
      if (typeof window !== 'undefined' && window.history) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch {
      // ignore
    }
  };

  /**
   * Format input code to uppercase XXX-XXX
   */
  const handleCodeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!val.includes('-') && val.length > 3) {
      val = `${val.slice(0, 3)}-${val.slice(3, 6)}`;
    }
    if (val.length > 7) {
      val = val.slice(0, 7);
    }
    setInputCode(val);
  };

  /**
   * Sender: Handle selecting files
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      setSelectedFiles((prev) => [...prev, ...filesArray]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * Sender: Start room and generate Code / QR
   */
  const startSharing = async () => {
    if (selectedFiles.length === 0) return;

    resetSession();
    setStatusMessage('Connecting to signaling network...');
    setErrorMessage('');

    try {
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      let currentCode = '';

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'create-room' }));
      };

      ws.onmessage = async (event) => {
        // Binary frames over WS on sender side (e.g. TRANSFER_ACK)
        if (event.data instanceof ArrayBuffer) {
          const packet = decodePacket(event.data);
          if (packet.type === 'control') {
            if (packet.message.type === 'TRANSFER_ACK') {
              setIsComplete(true);
              setStatusMessage('All files received and verified by receiver!');
            } else if (packet.message.type === 'TRANSFER_CANCEL') {
              cancelTransferRef.current = true;
              setErrorMessage('Transfer was cancelled by receiver');
              resetSession();
            }
          }
          return;
        }

        let textData = '';
        if (typeof event.data === 'string') {
          textData = event.data;
        } else if (event.data instanceof Blob) {
          textData = await event.data.text();
        }

        let msg: any;
        try {
          msg = JSON.parse(textData);
        } catch (e) {
          console.warn('[WS Sender] Failed to parse JSON:', e);
          return;
        }

        if (msg.type === 'room-created') {
          const code = msg.code;
          const ips: string[] = msg.localIps || [];
          setDiscoveredLocalIps(ips);
          currentCode = code;
          setSenderCode(code);
          const url = `${window.location.origin}/?code=${code}`;
          setShareUrl(url);
          setStatusMessage('Waiting for receiver to connect...');

          logger.setSession('sender', code, ws);
          logger.info('NETWORK', `Room created on signaling server: Code [${code}], Discovered Local IPs: [${ips.join(', ')}]`);

          // Initialize WebRTC as Sender with discovered local IPs for direct LAN de-anonymization
          initSenderWebRTC(code, ws, ips);
        } else if (msg.type === 'peer-joined') {
          setIsQrOpen(false);
          setStatusMessage('Receiver connected! Establishing secure tunnel...');
          logger.success('NETWORK', 'Receiver connected to room! Initiating WebRTC offer...');

          // Start WebRTC offer
          if (webrtcRef.current) {
            const offer = await webrtcRef.current.createOffer();
            ws.send(JSON.stringify({ type: 'signal', data: { sdp: offer } }));
          }

          // Fallback Timer: Give WebRTC 8.0s to establish direct LAN or WAN before falling back to relay
          clearTimeout(relayFallbackTimeoutRef.current);
          relayFallbackTimeoutRef.current = setTimeout(() => {
            if (!p2pEstablishedRef.current && !isTransferringRef.current && !isCompleteRef.current) {
              console.log('[BlackHole] Direct P2P timed out (8.0s), switching to Encrypted Relay...');
              startRelaySender(currentCode);
            }
          }, 8000);
        } else if (msg.type === 'signal') {
          if (msg.data?.requestRelay) {
            if (p2pEstablishedRef.current || isTransferringRef.current) {
              console.log('[BlackHole] Ignored requestRelay: WebRTC P2P is already established/transferring.');
              return;
            }
            console.log('[BlackHole] Receiver requested Encrypted Relay fallback...');
            startRelaySender(currentCode);
          } else if (msg.data?.sdp) {
            setStatusMessage('Answer received! Opening encrypted tunnel...');
            await webrtcRef.current?.handleAnswer(msg.data.sdp);
          } else if (msg.data?.candidate) {
            await webrtcRef.current?.handleCandidate(msg.data.candidate);
          }
        } else if (msg.type === 'peer-disconnected') {
          if (!isCompleteRef.current) {
            setStatusMessage('Receiver disconnected');
            setConnectionMode('disconnected');
          }
        } else if (msg.type === 'error') {
          if (!isCompleteRef.current) {
            setErrorMessage(msg.message);
          }
        }
      };

      ws.onerror = () => {
        if (!isCompleteRef.current) {
          setErrorMessage('Cannot connect to BlackHole signaling server. Make sure the server is running.');
        }
      };
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to start sharing');
    }
  };

  /**
   * Sender: Fallback to Encrypted WebSocket Relay
   */
  const startRelaySender = async (code: string) => {
    if (connectionModeRef.current === 'relay') return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    clearTimeout(relayFallbackTimeoutRef.current);
    setIsQrOpen(false);

    logger.warn('NETWORK', 'Direct P2P unreachable or dropped. Switching transport to Encrypted WebSocket Relay');

    // Notify receiver over signaling that we are using the Encrypted Relay
    wsRef.current.send(JSON.stringify({ type: 'signal', data: { switchToRelay: true } }));

    setConnectionMode('relay');
    setStatusMessage('Connected via Encrypted Relay! Streaming files...');
    setIsTransferring(true);
    cancelTransferRef.current = false;

    const relayTransport: PacketTransport = {
      sendPacket: async (data: Uint8Array) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          throw new Error('Relay connection closed');
        }
        if (cancelTransferRef.current) {
          throw new Error('Transfer cancelled');
        }
        // WebSocket buffer flow control: keep at most 2MB queued
        while (wsRef.current && wsRef.current.bufferedAmount > 2 * 1024 * 1024) {
          if (cancelTransferRef.current) throw new Error('Transfer cancelled');
          await new Promise((r) => setTimeout(r, 15));
        }
        if (cancelTransferRef.current) throw new Error('Transfer cancelled');
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          throw new Error('Relay connection closed');
        }
        // Send pure binary frame - zero base64 bloat!
        wsRef.current.send(data.buffer as ArrayBuffer);
      },
    };

    try {
      const cryptoKey = await deriveKeyFromSecret(code);
      await sendFiles(
        selectedFiles,
        relayTransport,
        cryptoKey,
        (p) => setProgress(p),
        () => cancelTransferRef.current
      );

      setStatusMessage('Payload delivered! Awaiting receiver verification...');
      setTimeout(() => {
        if (!isCompleteRef.current) {
          setIsComplete(true);
          setStatusMessage('Transfer completed successfully!');
        }
      }, 10000);
    } catch (err: any) {
      if (cancelTransferRef.current) return;
      console.error('[Relay Sender Error]', err);
      setErrorMessage(err.message || 'Transfer interrupted');
    }
  };

  const initSenderWebRTC = (code: string, ws: WebSocket, localIps: string[] = []) => {
    const webrtc = new WebRTCManager(true, {
      onConnectionModeChange: (mode) => {
        if (connectionModeRef.current !== 'relay') {
          setConnectionMode(mode);
        }
      },
      onSignal: (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', data }));
        }
      },
      onDataChannelOpen: async () => {
        // WebRTC DataChannel opened! Clear the fallback timer immediately so relay doesn't abort WebRTC
        p2pEstablishedRef.current = true;
        clearTimeout(relayFallbackTimeoutRef.current);
        relayFallbackTimeoutRef.current = null;
        setIsQrOpen(false);
        setStatusMessage('Verifying P2P channel liveness...');
        let pongReceived = false;

        // Listen for PONG on the DataChannel
        const dataChannel = webrtc.getDataChannel();
        const onPingPongMessage = (event: MessageEvent) => {
          if (event.data instanceof ArrayBuffer) {
            const packet = decodePacket(event.data);
            if (packet.type === 'control' && packet.message.type === 'RTC_PONG') {
              pongReceived = true;
            }
          }
        };

        if (dataChannel) {
          dataChannel.addEventListener('message', onPingPongMessage);
          // Send PING
          try {
            await webrtc.sendPacket(encodeControlPacket({ type: 'RTC_PING' }));
          } catch {
            // failed to send ping
          }
        }

        // Wait up to 2.5s for PONG
        for (let i = 0; i < 25; i++) {
          if (pongReceived) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        if (dataChannel) {
          dataChannel.removeEventListener('message', onPingPongMessage);
        }

        if (pongReceived) {
          p2pEstablishedRef.current = true;
          clearTimeout(relayFallbackTimeoutRef.current);
          relayFallbackTimeoutRef.current = null;
          setStatusMessage('Direct secure connection established! Transferring...');
          isTransferringRef.current = true;
          setIsTransferring(true);
          cancelTransferRef.current = false;

          try {
            const cryptoKey = await deriveKeyFromSecret(code);
            await sendFiles(
              selectedFiles,
              webrtc,
              cryptoKey,
              (p) => setProgress(p),
              () => cancelTransferRef.current
            );

            isCompleteRef.current = true;
            setIsComplete(true);
            setStatusMessage('Transfer completed successfully!');
          } catch (err: any) {
            if (cancelTransferRef.current) return;
            console.error('[Sender Transfer Error]', err);
            logger.error('STREAM', `Sender transfer error: ${err?.message || err}`);
            // If direct WebRTC drops mid-transfer, fallback to relay
            startRelaySender(code);
          }
        } else {
          console.warn('[WebRTC] Direct UDP blocked by network/hotspot. Switching to Relay...');
          startRelaySender(code);
        }
      },
      onDataChannelClose: () => {
        if (!isCompleteRef.current) {
          logger.warn('WEBRTC', 'DataChannel closed mid-session. Triggering Encrypted Relay fallback...');
          startRelaySender(code);
        } else {
          setStatusMessage('Transfer channel closed');
        }
      },
      onError: (err) => {
        logger.error('WEBRTC', 'WebRTC error triggered relay fallback', err);
        startRelaySender(code);
      },
    }, localIps);

    webrtc.init();
    webrtcRef.current = webrtc;
  };

  /**
   * Receiver: Connect via code
   */
  const connectAsReceiver = async (targetCode?: string) => {
    const code = (targetCode || inputCode).trim().toUpperCase();
    if (!code) {
      setErrorMessage('Please enter a valid room code');
      return;
    }

    resetSession();
    setIsConnecting(true);
    setStatusMessage('Connecting to signaling network...');
    setErrorMessage('');

    try {
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const packetQueue: ArrayBuffer[] = [];

      // Initialize WebRTC as receiver IMMEDIATELY so webrtcRef.current is ready for any incoming offer
      initReceiverWebRTC(code, ws, packetQueue);

      ws.onopen = () => {
        setStatusMessage('Contacting sender...');
        logger.setSession('receiver', code, ws);
        logger.info('NETWORK', `Joining room [${code}] over WebSocket signaling...`);
        ws.send(JSON.stringify({ type: 'join-room', code }));

        // Fallback: If still connecting after 9.5s, request encrypted relay from sender
        clearTimeout(relayFallbackTimeoutRef.current);
        relayFallbackTimeoutRef.current = setTimeout(() => {
          if (!p2pEstablishedRef.current && !isTransferringRef.current && !isCompleteRef.current && ws.readyState === WebSocket.OPEN) {
            logger.warn('NETWORK', 'Direct P2P connection taking long (9.5s). Requesting relay fallback...');
            ws.send(JSON.stringify({ type: 'signal', data: { requestRelay: true } }));
          }
        }, 9500);
      };

      ws.onmessage = async (event) => {
        // 1. Direct raw binary packet received over WebSocket relay!
        if (event.data instanceof ArrayBuffer) {
          const packet = decodePacket(event.data);
          if (packet.type === 'control' && packet.message.type === 'TRANSFER_CANCEL') {
            logger.warn('STREAM', 'Transfer cancelled by sender');
            setErrorMessage('Transfer was cancelled by sender');
            resetSession();
            return;
          }

          if (!isTransferringRef.current) {
            clearTimeout(relayFallbackTimeoutRef.current);
            setConnectionMode('relay');
            setIsConnecting(false);
            setIsTransferring(true);
            setStatusMessage('Connected via Encrypted Relay! Receiving stream...');
            logger.warn('NETWORK', 'Connected via Encrypted WebSocket Relay');
          }
          if (receiverEngineRef.current) {
            receiverEngineRef.current.handlePacket(event.data);
          } else {
            packetQueue.push(event.data);
          }
          return;
        }

        // 2. JSON control / signaling message
        let textData = '';
        if (typeof event.data === 'string') {
          textData = event.data;
        } else if (event.data instanceof Blob) {
          textData = await event.data.text();
        }

        let msg: any;
        try {
          msg = JSON.parse(textData);
        } catch (e) {
          console.warn('[WS Receiver] Failed to parse JSON:', e);
          return;
        }

        if (msg.type === 'room-joined') {
          setStatusMessage('Room joined! Exchanging network routes...');
          const ips: string[] = msg.localIps || [];
          logger.success('NETWORK', `Joined room [${code}]. Sender local IPs: [${ips.join(', ')}]`);
          if (ips.length > 0 && webrtcRef.current) {
            webrtcRef.current.knownLocalIps = ips;
          }
        } else if (msg.type === 'signal') {
          if (msg.data?.switchToRelay) {
            console.log('[Receiver] Received switchToRelay instruction from sender');
            clearTimeout(relayFallbackTimeoutRef.current);
            setConnectionMode('relay');
            setIsConnecting(false);
            setIsTransferring(true);
            setStatusMessage('Connected via Encrypted Relay! Receiving stream...');
          } else if (msg.data?.sdp) {
            if (msg.data.sdp.type === 'offer') {
              setStatusMessage('Received offer! Generating secure answer...');
              if (webrtcRef.current) {
                const answer = await webrtcRef.current.createAnswer(msg.data.sdp);
                ws.send(JSON.stringify({ type: 'signal', data: { sdp: answer } }));
                setStatusMessage('Answer sent! Establishing P2P data tunnel...');
              }
            }
          } else if (msg.data?.candidate) {
            await webrtcRef.current?.handleCandidate(msg.data.candidate);
          }
        } else if (msg.type === 'peer-disconnected') {
          if (!isCompleteRef.current) {
            setStatusMessage('Sender disconnected');
            setConnectionMode('disconnected');
            setIsConnecting(false);
          }
        } else if (msg.type === 'error') {
          if (!isCompleteRef.current) {
            setErrorMessage(msg.message);
            setIsConnecting(false);
          }
        }
      };

      ws.onerror = () => {
        if (!isCompleteRef.current) {
          setErrorMessage('Cannot connect to BlackHole signaling server. Ensure server is online.');
          setIsConnecting(false);
        }
      };
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to connect');
      setIsConnecting(false);
    }
  };

  const initReceiverWebRTC = (code: string, ws: WebSocket, packetQueue: ArrayBuffer[], localIps: string[] = []) => {
    deriveKeyFromSecret(code).then((key) => {
      const receiverEngine = new FileReceiver(
        key,
        (p) => setProgress(p),
        (file) => {
          setReceivedFiles((prev) => [...prev, file]);
          // Attempt automatic download
          try {
            const a = document.createElement('a');
            a.href = file.downloadUrl;
            a.download = file.metadata.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } catch (e) {
            console.warn('[Auto-Download Blocked by Browser]', e);
          }
        },
        () => {
          isCompleteRef.current = true;
          setIsComplete(true);
          setStatusMessage('All files received and ready!');

          // Send confirmation ACK to sender so sender marks 100% simultaneously
          try {
            const ack = encodeControlPacket({ type: 'TRANSFER_ACK' });
            if (webrtcRef.current && connectionModeRef.current !== 'relay') {
              webrtcRef.current.sendPacket(ack).catch(() => {});
            }
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(ack.buffer as ArrayBuffer);
            }
          } catch (e) {
            console.warn('[ACK Send Failed]', e);
          }
        }
      );

      receiverEngineRef.current = receiverEngine;

      // Process any packets received while key was being derived
      while (packetQueue.length > 0) {
        const queued = packetQueue.shift();
        if (queued) receiverEngine.handlePacket(queued);
      }
    })
    .catch((err) => {
      console.error('[Receiver Crypto Key Error]', err);
      setErrorMessage('Failed to initialize decryption engine: ' + (err?.message || err));
    });

    const webrtc = new WebRTCManager(false, {
      onConnectionModeChange: (mode) => {
        if (connectionModeRef.current !== 'relay') {
          setConnectionMode(mode);
        }
      },
      onSignal: (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', data }));
        }
      },
      onDataChannelOpen: () => {
        p2pEstablishedRef.current = true;
        clearTimeout(relayFallbackTimeoutRef.current);
        relayFallbackTimeoutRef.current = null;
        setStatusMessage('Connected! Receiving file stream...');
      },
      onDataReceived: (data) => {
        p2pEstablishedRef.current = true;
        clearTimeout(relayFallbackTimeoutRef.current);
        relayFallbackTimeoutRef.current = null;
        if (!isTransferringRef.current) {
          isTransferringRef.current = true;
          setIsTransferring(true);
        }
        const packet = decodePacket(data);
        if (packet.type === 'control') {
          if (packet.message.type === 'RTC_PING') {
            // Immediately reply with PONG so sender knows WebRTC is verified
            webrtc.sendPacket(encodeControlPacket({ type: 'RTC_PONG' }));
            setIsConnecting(false);
            setStatusMessage('Direct P2P Verified! Receiving stream...');
            return;
          }
          if (packet.message.type === 'TRANSFER_CANCEL') {
            setErrorMessage('Transfer was cancelled by sender');
            resetSession();
            return;
          }
        }

        if (receiverEngineRef.current) {
          receiverEngineRef.current.handlePacket(data);
        } else {
          packetQueue.push(data);
        }
      },
      onDataChannelClose: () => {
        if (!isCompleteRef.current && connectionModeRef.current !== 'relay') {
          logger.warn('WEBRTC', 'DataChannel closed on receiver. Requesting Encrypted Relay fallback from sender...');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'signal', data: { requestRelay: true } }));
          }
        }
      },
      onError: (err) => {
        logger.error('WEBRTC', 'WebRTC Receiver error encountered', err);
        if (!isCompleteRef.current && connectionModeRef.current !== 'relay') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'signal', data: { requestRelay: true } }));
          }
        }
      },
    }, localIps);

    webrtc.init();
    webrtcRef.current = webrtc;
  };

  const copyCode = () => {
    if (senderCode) {
      navigator.clipboard.writeText(senderCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const totalSelectedSize = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-between p-3 sm:p-6 lg:p-8 relative selection:bg-purple-500/30 selection:text-purple-200">
      {/* Background Cosmic Atmosphere */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] sm:w-[700px] h-[350px] sm:h-[700px] bg-purple-900/15 rounded-full blur-[100px] sm:blur-[140px]" />
        <div className="absolute bottom-10 left-1/4 w-[250px] sm:w-[500px] h-[250px] sm:h-[500px] bg-cyan-900/10 rounded-full blur-[90px] sm:blur-[120px]" />
      </div>

      {/* Header */}
      <header className="w-full max-w-4xl flex items-center justify-between py-3 sm:py-4 relative z-10 border-b border-slate-900">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            <BlackHoleLogo size={42} className="w-10 h-10 sm:w-11 sm:h-11 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]" />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white flex items-center gap-2">
              BlackHole
              <span className="text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
                P2P & LAN
              </span>
            </h1>
            <p className="text-[11px] sm:text-xs text-slate-400">Zero-Knowledge Encrypted File Wormhole</p>
          </div>
        </div>

        {/* Feature Badges (LAN / WAN / Crypto) */}
        <div className="hidden md:flex items-center gap-3 text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            Local Wire Speed
          </span>
          <span className="text-slate-700">•</span>
          <span className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            Internet NAT P2P
          </span>
          <span className="text-slate-700">•</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />
            AES-256 E2EE
          </span>
        </div>
      </header>

      {/* Main Container */}
      <main className="w-full max-w-2xl my-4 sm:my-8 relative z-10 flex flex-col items-center">
        {/* Navigation Tabs */}
        {!isTransferring && !isComplete && !isConnecting && (
          <div className="flex p-1.5 bg-slate-900/80 border border-slate-800 rounded-2xl mb-6 sm:mb-8 backdrop-blur-md w-full sm:w-auto">
            <button
              onClick={() => {
                setActiveTab('send');
                setErrorMessage('');
              }}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-5 sm:px-6 py-2.5 rounded-xl font-medium text-xs sm:text-sm transition-all ${
                activeTab === 'send'
                  ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg shadow-purple-600/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="w-4 h-4" />
              <span>Send Files</span>
            </button>
            <button
              onClick={() => {
                setActiveTab('receive');
                setErrorMessage('');
              }}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-5 sm:px-6 py-2.5 rounded-xl font-medium text-xs sm:text-sm transition-all ${
                activeTab === 'receive'
                  ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-600/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Download className="w-4 h-4" />
              <span>Receive Files</span>
            </button>
          </div>
        )}

        {/* Error Notification */}
        {errorMessage && (
          <div className="w-full mb-6 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between">
            <span>{errorMessage}</span>
            <button onClick={() => setErrorMessage('')} className="p-1 hover:text-rose-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Connecting Screen on Receiver */}
        {isConnecting && !isTransferring && (
          <div className="w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-6 sm:p-10 text-center backdrop-blur-xl shadow-2xl relative overflow-hidden">
            <div className="relative inline-block mb-6">
              <div className="absolute inset-0 rounded-full blur-xl bg-cyan-500/20 animate-pulse" />
              <BlackHoleLogo size={80} className="w-20 h-20 animate-spin [animation-duration:8s] relative z-10" />
            </div>

            <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">Connecting to Sender</h3>
            <p className="text-xs sm:text-sm text-cyan-300 font-mono mb-4">{statusMessage || 'Establishing encrypted tunnel...'}</p>

            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-950 border border-slate-800 text-xs font-mono text-slate-400 mb-8">
              <span>Code:</span>
              <span className="text-cyan-400 font-bold">{inputCode}</span>
            </div>

            <div>
              <button
                onClick={resetSession}
                className="py-2.5 px-6 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors"
              >
                Cancel Connection
              </button>
            </div>
          </div>
        )}

        {/* Transfer In-Progress View */}
        {(isTransferring || isComplete) && (
          <div className="w-full space-y-6">
            <TransferProgressView
              progress={progress}
              mode={connectionMode}
              isSender={activeTab === 'send'}
              isComplete={isComplete}
              onCancel={() => {
                cancelTransferRef.current = true;
                try {
                  const cancelPacket = encodeControlPacket({ type: 'TRANSFER_CANCEL' as any });
                  webrtcRef.current?.sendPacket(cancelPacket).catch(() => {});
                  if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    wsRef.current.send(cancelPacket.buffer as ArrayBuffer);
                  }
                } catch {}
                setStatusMessage('Transfer cancelled');
                resetSession();
              }}
            />

            {/* Received Files Download Cards */}
            {activeTab === 'receive' && receivedFiles.length > 0 && (
              <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5">
                <h4 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
                  <Check className="w-4 h-4 text-emerald-400" />
                  Files Ready ({receivedFiles.length})
                </h4>
                <div className="space-y-3">
                  {receivedFiles.map((f, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-2xl bg-slate-950 border border-slate-800"
                    >
                      <div className="flex items-center gap-3 truncate min-w-0 mb-3">
                        <FileIcon className="w-5 h-5 text-cyan-400 shrink-0" />
                        <div className="truncate">
                          <span className="text-sm font-medium text-slate-200 block truncate">{f.metadata.name}</span>
                          <span className="text-xs text-slate-500 font-mono">
                            {formatBytes(f.metadata.size)}
                          </span>
                        </div>
                      </div>
                      <a
                        href={f.downloadUrl}
                        download={f.metadata.name}
                        className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs sm:text-sm text-center flex items-center justify-center gap-2 shadow-lg shadow-cyan-600/25 transition-all active:scale-[0.98]"
                      >
                        <Download className="w-4 h-4" />
                        <span>Save to Device</span>
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Reset / Send More Button */}
            {isComplete && (
              <button
                onClick={() => {
                  const currentTab = activeTab;
                  resetSession();
                  setActiveTab(currentTab);
                }}
                className="w-full py-3.5 bg-gradient-to-r from-purple-600/20 via-indigo-600/20 to-cyan-600/20 hover:from-purple-600/30 hover:to-cyan-600/30 text-slate-100 border border-slate-700/80 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2 transition-all shadow-xl active:scale-[0.99]"
              >
                <RefreshCw className="w-4 h-4" />
                <span>{activeTab === 'send' ? 'Send More Files (New Transfer)' : 'Receive Another File'}</span>
              </button>
            )}
          </div>
        )}

        {/* TAB 1: SENDER VIEW */}
        {activeTab === 'send' && !isTransferring && !isComplete && (
          <div className="w-full space-y-6">
            {!senderCode ? (
              <>
                {/* Upload / Dropzone */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.files) {
                      setSelectedFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
                    }
                  }}
                  className="w-full border-2 border-dashed border-slate-800 hover:border-purple-500/50 bg-slate-900/40 hover:bg-slate-900/70 rounded-3xl p-6 sm:p-12 text-center cursor-pointer transition-all duration-300 group flex flex-col items-center justify-center relative overflow-hidden"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-3xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 group-hover:scale-110 group-hover:bg-purple-500/20 transition-all duration-300 mb-4 shadow-xl shadow-purple-900/10">
                    <Upload className="w-7 h-7 sm:w-8 sm:h-8" />
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-1">
                    Choose files or drag & drop here
                  </h3>
                  <p className="text-xs text-slate-400 mb-4">
                    Send any size or format • Multiple files supported
                  </p>
                  <span className="px-4 py-2 rounded-xl bg-purple-600/20 border border-purple-500/30 text-purple-300 text-xs font-semibold group-hover:bg-purple-600 group-hover:text-white transition-all">
                    Browse Files
                  </span>
                </div>

                {/* Selected Files List */}
                {selectedFiles.length > 0 && (
                  <div className="bg-slate-900/80 border border-slate-800 rounded-3xl p-4 sm:p-5 backdrop-blur-md">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Selected Files ({selectedFiles.length})
                      </span>
                      <span className="text-xs font-mono text-purple-400">
                        Total: {formatBytes(totalSelectedSize)}
                      </span>
                    </div>

                    <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                      {selectedFiles.map((file, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 gap-2"
                        >
                          <div className="flex items-center gap-3 truncate min-w-0">
                            <FileIcon className="w-4 h-4 text-purple-400 shrink-0" />
                            <span className="text-sm text-slate-200 truncate">{file.name}</span>
                            <span className="text-xs text-slate-500 shrink-0 hidden sm:inline">
                              ({formatBytes(file.size)})
                            </span>
                          </div>
                          <button
                            onClick={() => removeFile(idx)}
                            className="p-1 text-slate-500 hover:text-rose-400 transition-colors shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Start Transfer Button */}
                    <button
                      onClick={startSharing}
                      className="w-full mt-4 py-3.5 sm:py-4 px-6 bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-500 hover:opacity-95 text-white font-semibold rounded-2xl shadow-xl shadow-purple-600/30 active:scale-[0.99] transition-all flex items-center justify-center gap-2 text-sm sm:text-base"
                    >
                      <Share2 className="w-5 h-5" />
                      <span>Generate Code & Start Sharing</span>
                    </button>
                  </div>
                )}
              </>
            ) : (
              /* Code & QR Code Display */
              <div className="w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-8 text-center backdrop-blur-xl relative overflow-hidden shadow-2xl">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400 mb-3">
                  <Share2 className="w-6 h-6" />
                </div>
                <h3 className="text-lg sm:text-xl font-bold text-white mb-1">Your BlackHole Code</h3>
                <p className="text-xs text-slate-400 mb-6">
                  Share this code or scan the QR code on the receiving device
                </p>

                {/* Big Code Card */}
                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-5 sm:p-6 mb-6 relative">
                  <span className="text-[11px] sm:text-xs uppercase tracking-widest text-slate-500 block mb-2 font-mono">
                    Room Code
                  </span>
                  <div className="text-3xl sm:text-5xl font-mono font-extrabold tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-indigo-300 to-cyan-400">
                    {senderCode}
                  </div>
                </div>

                {/* Actions: Copy Code, View QR */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                  <button
                    onClick={copyCode}
                    className="flex items-center justify-center gap-2 py-3 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-xl border border-slate-700 transition-all text-sm"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedCode ? 'Code Copied!' : 'Copy Code'}</span>
                  </button>

                  <button
                    onClick={() => setIsQrOpen(true)}
                    className="flex items-center justify-center gap-2 py-3 px-4 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 font-medium rounded-xl border border-purple-500/30 transition-all text-sm"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>Show QR Code</span>
                  </button>
                </div>

                {/* Status indicator */}
                <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 flex items-center justify-center gap-2 text-xs text-slate-400">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-ping shrink-0" />
                  <span className="truncate">{statusMessage || 'Listening for receiver...'}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: RECEIVER VIEW */}
        {activeTab === 'receive' && !isTransferring && !isComplete && !isConnecting && (
          <div className="w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-8 backdrop-blur-xl shadow-2xl">
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 mb-3">
                <Download className="w-6 h-6" />
              </div>
              <h3 className="text-lg sm:text-xl font-bold text-white mb-1">Receive Files</h3>
              <p className="text-xs text-slate-400">
                Enter the code or scan the QR code to start receiving
              </p>
            </div>

            {/* Quick Camera Scanner Button */}
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setIsScannerOpen(true)}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs sm:text-sm font-semibold transition-all active:scale-[0.98] shadow-lg shadow-cyan-950/30"
              >
                <Camera className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" />
                <span>Scan QR Code with Camera</span>
              </button>
            </div>

            <div className="flex items-center gap-3 my-4">
              <div className="h-px bg-slate-800 flex-1" />
              <span className="text-[11px] text-slate-500 uppercase tracking-widest font-mono">or enter manually</span>
              <div className="h-px bg-slate-800 flex-1" />
            </div>

            {/* Code Input */}
            <div className="space-y-4 mb-6">
              <div>
                <label className="text-[11px] sm:text-xs uppercase tracking-wider text-slate-400 font-semibold block mb-2">
                  Enter 6-Character Code
                </label>
                <input
                  type="text"
                  placeholder="e.g. 7K9-X2M"
                  value={inputCode}
                  onChange={handleCodeInputChange}
                  maxLength={7}
                  className="w-full py-3.5 sm:py-4 px-4 sm:px-6 bg-slate-950 border border-slate-800 focus:border-cyan-500 focus:outline-none rounded-2xl text-center text-2xl sm:text-4xl font-mono tracking-widest text-cyan-300 placeholder:text-slate-700 transition-all uppercase"
                />
              </div>

              <button
                onClick={() => connectAsReceiver()}
                disabled={!inputCode.trim() || inputCode.trim().length < 6}
                className="w-full py-3.5 sm:py-4 px-6 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-2xl shadow-xl shadow-cyan-600/25 active:scale-[0.99] transition-all flex items-center justify-center gap-2 text-sm sm:text-base"
              >
                <span>Connect & Receive Files</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {/* Instructions */}
            <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800/80 text-xs text-slate-400 space-y-2">
              <div className="flex items-center gap-2 text-slate-300 font-medium">
                <ShieldCheck className="w-4 h-4 text-cyan-400" />
                <span>How BlackHole P2P Works:</span>
              </div>
              <p>• If both devices are on the same Wi-Fi, files stream directly over your local network at wire speed.</p>
              <p>• If devices are on different networks, a direct peer-to-peer tunnel is created across the internet.</p>
              <p>• Zero server storage: your files never touch any third-party server unencrypted.</p>
            </div>
          </div>
        )}
      </main>

      {/* QR Code Modal (Sender Display) */}
      <QRCodeModal
        isOpen={isQrOpen && !isTransferring && !isComplete && connectionMode === 'disconnected'}
        onClose={() => setIsQrOpen(false)}
        code={senderCode}
        shareUrl={shareUrl}
        localIps={discoveredLocalIps}
      />

      {/* QR Scanner Modal (Receiver Camera) */}
      <QRScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScanSuccess={(scannedCode) => {
          setInputCode(scannedCode.toUpperCase());
          connectAsReceiver(scannedCode.toUpperCase());
        }}
      />

      {/* Footer */}
      <footer className="w-full max-w-4xl py-4 border-t border-slate-900/80 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-2 relative z-10 text-center sm:text-left">
        <div>
          <span>BlackHole P2P File Transfer • End-to-End Encrypted</span>
        </div>
        <div className="flex items-center gap-2 justify-center">
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Signaling Ready
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
