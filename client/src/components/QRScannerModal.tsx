import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { X, Camera, AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (code: string) => void;
}

export const QRScannerModal: React.FC<Props> = ({ isOpen, onClose, onScanSuccess }) => {
  const [error, setError] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isDecodingFile, setIsDecodingFile] = useState<boolean>(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerId = 'blackhole-qr-reader';

  useEffect(() => {
    if (!isOpen) {
      stopScanner();
      return;
    }

    startScanner();

    return () => {
      stopScanner();
    };
  }, [isOpen]);

  const startScanner = async () => {
    setError('');
    setIsScanning(true);

    try {
      // Small delay to ensure DOM container is rendered
      await new Promise((r) => setTimeout(r, 150));

      // Check if getUserMedia is supported in current context
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera streaming not supported over insecure HTTP. Snap a photo of the QR code instead.');
      }

      const scanner = new Html5Qrcode(containerId, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scannerRef.current = scanner;

      const config = {
        fps: 10,
        qrbox: { width: 240, height: 240 },
        aspectRatio: 1.0,
      };

      await scanner.start(
        { facingMode: 'environment' }, // prefer rear camera on mobile
        config,
        (decodedText) => {
          handleDecodedText(decodedText);
        },
        () => {
          // Frame error (no QR detected in frame) - ignore
        }
      );
    } catch (err: any) {
      console.warn('[QR Scanner Error]', err);
      setIsScanning(false);
      const isHttpIssue = err?.message?.includes('not supported') || !window.isSecureContext;
      setError(
        err?.message?.includes('Permission')
          ? 'Camera permission denied. Please allow camera access in your browser settings.'
          : isHttpIssue
          ? 'Live video stream requires HTTPS. Use the camera photo button below to scan!'
          : 'Could not access device camera. You can snap a photo or type the code.'
      );
    }
  };

  const stopScanner = async () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (e) {
        console.warn('[Scanner Stop Error]', e);
      }
    }
    scannerRef.current = null;
    setIsScanning(false);
  };

  const handleDecodedText = (text: string) => {
    let code = text.trim();
    try {
      const url = new URL(text);
      const queryCode = url.searchParams.get('code');
      const hash = url.hash.replace('#', '');
      const hashCode = hash.startsWith('code=') ? hash.split('=')[1] : null;
      if (queryCode) code = queryCode;
      else if (hashCode) code = hashCode;
    } catch {
      // Not a full URL, use raw string
    }

    stopScanner();
    onScanSuccess(code);
    onClose();
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsDecodingFile(true);
      setError('');

      let scanner = scannerRef.current;
      if (!scanner) {
        scanner = new Html5Qrcode(containerId, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
        });
        scannerRef.current = scanner;
      }

      const decodedText = await scanner.scanFile(file, false);
      handleDecodedText(decodedText);
    } catch (err: any) {
      console.warn('[QR Photo Scan Error]', err);
      setError('No QR code detected in photo. Please ensure good lighting and try again.');
    } finally {
      setIsDecodingFile(false);
      e.target.value = '';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-sm p-6 bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl text-center overflow-hidden">
        {/* Hidden Camera / Photo File Input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileInputChange}
        />

        <button
          onClick={() => {
            stopScanner();
            onClose();
          }}
          className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-200 rounded-full hover:bg-slate-800 transition-colors z-20"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="inline-flex items-center justify-center w-12 h-12 mb-3 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
          <Camera className="w-6 h-6" />
        </div>

        <h3 className="text-xl font-bold text-white mb-1">Scan Room QR Code</h3>
        <p className="text-xs text-slate-400 mb-4">
          Point camera or snap a photo of the QR code
        </p>

        {/* Video Scanner Container */}
        <div className="relative w-full aspect-square rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center mb-4">
          <div id={containerId} className="w-full h-full" />

          {/* Scanner Overlay Box */}
          {isScanning && !error && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div className="w-56 h-56 border-2 border-cyan-400/80 rounded-2xl relative shadow-[0_0_20px_rgba(6,182,212,0.3)] animate-pulse">
                <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-cyan-300 rounded-tl-md" />
                <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-cyan-300 rounded-tr-md" />
                <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-cyan-300 rounded-bl-md" />
                <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-cyan-300 rounded-br-md" />
              </div>
            </div>
          )}

          {/* Loading when decoding photo */}
          {isDecodingFile && (
            <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center gap-2 z-30">
              <RefreshCw className="w-7 h-7 text-cyan-400 animate-spin" />
              <span className="text-xs text-slate-300 font-medium">Decoding QR photo...</span>
            </div>
          )}

          {/* Error Message & Snapshot Fallback */}
          {error && (
            <div className="p-4 text-center z-10 space-y-3">
              <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
              <p className="text-xs text-rose-300 px-2">{error}</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-xs shadow-lg shadow-cyan-600/30 transition-all active:scale-95"
              >
                <Camera className="w-4 h-4" />
                <span>Snap Photo with Camera</span>
              </button>
            </div>
          )}
        </div>

        {/* Snapshot / Gallery Button (Always Available) */}
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition-all active:scale-98"
          >
            <Camera className="w-4 h-4" />
            <span>Take Photo / Upload QR</span>
          </button>
        </div>

        <button
          onClick={() => {
            stopScanner();
            onClose();
          }}
          className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-xl text-xs transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};
