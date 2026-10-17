import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Check, QrCode, X, Smartphone, Wifi, Globe } from 'lucide-react';

interface Props {
  code: string;
  shareUrl: string;
  localIps?: string[];
  isOpen: boolean;
  onClose: () => void;
}

export const QRCodeModal: React.FC<Props> = ({ code, shareUrl, localIps = [], isOpen, onClose }) => {
  const [copied, setCopied] = useState(false);
  // Default to secure link ('wan') so mobile devices get hardware WebCrypto and camera permissions.
  // Direct LAN wire speed is still automatically used by WebRTC when on the same Wi-Fi!
  const [mode, setMode] = useState<'lan' | 'wan'>('wan');

  if (!isOpen) return null;

  const lanUrl = localIps.length > 0 ? `http://${localIps[0]}:5173/?code=${code}` : '';
  const activeUrl = mode === 'lan' && lanUrl ? lanUrl : shareUrl;

  const handleCopy = () => {
    navigator.clipboard.writeText(activeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-sm p-6 bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl text-center">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-200 rounded-full hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
          <QrCode className="w-6 h-6" />
        </div>

        <h3 className="text-xl font-bold text-white mb-1">Scan to Receive</h3>
        <p className="text-xs text-slate-400 mb-3 flex items-center justify-center gap-1">
          <Smartphone className="w-3.5 h-3.5 text-purple-400" />
          Point your mobile camera at this code
        </p>

        {/* Network Mode Toggle (if local IP discovered) */}
        {lanUrl && (
          <div className="flex items-center justify-center gap-1.5 p-1 bg-slate-950/80 rounded-2xl border border-slate-800 mb-4 text-xs">
            <button
              type="button"
              onClick={() => setMode('wan')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl font-medium transition-all ${
                mode === 'wan'
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>Secure Link (Best)</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('lan')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-xl font-medium transition-all ${
                mode === 'lan'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Wifi className="w-3.5 h-3.5" />
              <span>Offline Direct IP</span>
            </button>
          </div>
        )}

        {/* QR Code Container */}
        <div className="inline-block p-4 bg-white rounded-2xl shadow-inner mb-3">
          <QRCodeSVG
            value={activeUrl}
            size={200}
            level="M"
            includeMargin={false}
          />
        </div>

        {mode === 'lan' && lanUrl ? (
          <p className="text-[11px] text-amber-400 font-mono mb-3">
            ⚡ Direct Local IP Stream (Zero Internet Needed)
          </p>
        ) : (
          <p className="text-[11px] text-emerald-400 font-mono mb-3">
            ⚡ Direct Wi-Fi Wire Speed (0 Internet Data Used for Files)
          </p>
        )}

        {/* Display Code */}
        <div className="mb-4">
          <span className="text-xs uppercase tracking-wider text-slate-500 block mb-1">Room Code</span>
          <div className="text-2xl font-mono font-bold tracking-widest text-purple-300 bg-slate-950/70 py-2 rounded-xl border border-slate-800">
            {code}
          </div>
        </div>

        {/* Copy Link Button */}
        <button
          onClick={handleCopy}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-purple-600 hover:bg-purple-500 active:scale-[0.98] text-white font-medium rounded-xl transition-all shadow-lg shadow-purple-600/25"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-300" /> : <Copy className="w-4 h-4" />}
          <span>{copied ? 'Link Copied!' : 'Copy Direct Link'}</span>
        </button>
      </div>
    </div>
  );
};
