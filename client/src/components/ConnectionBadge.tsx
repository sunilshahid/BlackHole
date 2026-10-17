import React from 'react';
import type { ConnectionMode } from '../lib/webrtc';
import { Zap, Globe, Shield, Loader2, WifiOff } from 'lucide-react';

interface Props {
  mode: ConnectionMode;
}

export const ConnectionBadge: React.FC<Props> = ({ mode }) => {
  switch (mode) {
    case 'lan':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.2)]">
          <Zap className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
          <span>Direct LAN (Local Wire Speed)</span>
        </span>
      );

    case 'wan':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.2)]">
          <Globe className="w-3.5 h-3.5 text-cyan-400" />
          <span>Direct Internet P2P</span>
        </span>
      );

    case 'relay':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/15 text-purple-400 border border-purple-500/30 shadow-[0_0_12px_rgba(168,85,247,0.2)]">
          <Shield className="w-3.5 h-3.5 text-purple-400" />
          <span>Encrypted Relay</span>
        </span>
      );

    case 'connecting':
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
          <span>Negotiating P2P Tunnel...</span>
        </span>
      );

    case 'disconnected':
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
          <WifiOff className="w-3.5 h-3.5" />
          <span>Disconnected</span>
        </span>
      );
  }
};
