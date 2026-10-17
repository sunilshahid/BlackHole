# 🌌 BlackHole: Zero-Knowledge P2P & LAN File Transfer

**BlackHole** is a modern, high-performance, browser-to-browser peer-to-peer file transfer application. Built from scratch with **React 19, Vite, TypeScript, Tailwind CSS v4, and Node.js WebSockets**, it combines the simplicity of **Wormhole.app** with the local network speed of **Croc**.

---

## ✨ Features

- **Multi-File Upload & Drag-and-Drop:** Select multiple files or drag and drop whole batches.
- **Auto Code & QR Code Generation:** Senders receive a human-readable 6-digit code (e.g., `742-819`) and a scannable QR code for instant camera-to-camera pairing on phones and tablets.
- **Dual-Path Network Engine (LAN vs. WAN):**
  - **Same Network (LAN):** Automatically prioritizes WebRTC `host` ICE candidates. If both devices are connected to the same Wi-Fi or router, data streams locally at full hardware wire speed (1 Gbps+) with **0 bytes leaving your local network**.
  - **Different Network (WAN):** Automatically punches through NATs and firewalls via STUN for direct Internet P2P.
- **Zero-Knowledge End-to-End Encryption (E2EE):**
  - Uses the native browser **Web Crypto API** (`crypto.subtle`).
  * Files are chunked and encrypted with **AES-256-GCM** with unique 12-byte initialization vectors per block.
  * The encryption key is derived locally using PBKDF2/HKDF from the secret code—the server never sees or stores file data or encryption keys.
- **Zero-RAM Memory Safety (Backpressure Engine):**
  - Streams 64KB chunks governed by `bufferedAmount` and `onbufferedamountlow` events.
  - Prevents memory bloat and browser crashes when transferring files of any size (even 50 GB+).
- **Dedicated Receiver Tab:** Simple, clean input with auto-paste, instant link recognition (`/?code=742-819`), and automatic download triggering.

---

## 🚀 Quick Start

### 1. Start Both Client and Signaling Server
From the root directory, run:

```bash
# On Windows PowerShell:
npm.cmd run dev

# Or on standard Bash / Linux / Mac:
npm run dev
```

This concurrently starts:
- **Signaling Server:** `http://localhost:3001` (WebSocket server)
- **Web Client:** `http://localhost:5173` (Vite dev server)

> **Tip for Local Network / Mobile Testing:**  
> The Vite client binds to `0.0.0.0:5173`. You can open `http://<your-pc-lan-ip>:5173` (e.g., `http://192.168.1.5:5173`) on your mobile phone or laptop connected to the same Wi-Fi network!

---

## 📁 Project Structure

```
BlackHole/
├── client/                     # Vite + React 19 + TypeScript Frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── ConnectionBadge.tsx     # LAN vs. WAN vs. Relay live indicator
│   │   │   ├── QRCodeModal.tsx         # Mobile camera pairing modal
│   │   │   └── TransferProgressView.tsx# Real-time speedometer, ETA & progress
│   │   ├── lib/
│   │   │   ├── crypto.ts       # Web Crypto AES-256-GCM encryption & HKDF
│   │   │   ├── protocol.ts     # Binary framing (OpCodes, headers, chunking)
│   │   │   ├── streaming.ts    # File chunking & backpressure stream engine
│   │   │   └── webrtc.ts       # PeerConnection, candidate inspection & ICE racing
│   │   ├── App.tsx             # Main dual-tab UI (Send & Receive)
│   │   ├── index.css           # Tailwind CSS v4 styling & cosmic effects
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
├── server/                     # Node.js TypeScript Signaling Server
│   ├── src/
│   │   ├── rooms.ts            # Ephemeral in-memory matchmaking
│   │   └── index.ts            # WebSocket server & SDP/ICE relay
│   ├── package.json
│   └── tsconfig.json
├── package.json                # Root concurrently runner
└── README.md
```

---

## 🔒 Security & Privacy Notice
BlackHole is structurally zero-knowledge:
1. Files never touch the signaling server.
2. The server only routes WebRTC connection establishment messages (SDP and ICE candidates).
3. Plaintext files stay strictly on the sender and receiver's local devices.
