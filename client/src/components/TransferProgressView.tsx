import React from 'react';
import { type TransferProgress, formatBytes, formatSpeed, formatTime } from '../lib/streaming';
import { ConnectionBadge } from './ConnectionBadge';
import type { ConnectionMode } from '../lib/webrtc';
import { ArrowDownCircle, ArrowUpCircle, CheckCircle2, Clock, Gauge, X } from 'lucide-react';

interface Props {
  progress: TransferProgress | null;
  mode: ConnectionMode;
  isSender: boolean;
  isComplete: boolean;
  onCancel?: () => void;
}

export const TransferProgressView: React.FC<Props> = ({
  progress,
  mode,
  isSender,
  isComplete,
  onCancel,
}) => {
  const percentage = progress?.percentage || (isComplete ? 100 : 0);

  return (
    <div className="w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-xl">
      {/* Background glow based on status */}
      <div
        className={`absolute -top-24 -left-24 w-48 h-48 rounded-full blur-3xl pointer-events-none ${
          isComplete ? 'bg-emerald-500/15' : 'bg-purple-500/15'
        }`}
      />

      {/* Header status */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 relative z-10">
        <div className="flex items-center gap-3">
          <div
            className={`p-2.5 rounded-2xl ${
              isComplete
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : isSender
                ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
            }`}
          >
            {isComplete ? (
              <CheckCircle2 className="w-6 h-6 text-emerald-400" />
            ) : isSender ? (
              <ArrowUpCircle className="w-6 h-6 text-purple-400 animate-bounce" />
            ) : (
              <ArrowDownCircle className="w-6 h-6 text-cyan-400 animate-bounce" />
            )}
          </div>
          <div>
            <h4 className="font-semibold text-white text-base">
              {isComplete
                ? 'Transfer Finished!'
                : isSender
                ? 'Sending Files...'
                : 'Receiving Files...'}
            </h4>
            <p className="text-xs text-slate-400 truncate max-w-[200px] sm:max-w-xs">
              {progress?.currentFileName || (isComplete ? 'All files delivered' : 'Preparing stream...')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ConnectionBadge mode={mode} />
          {!isComplete && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              title="Cancel Transfer"
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-slate-700/80 hover:border-rose-500/30 transition-all flex items-center gap-1.5 text-xs font-medium active:scale-95"
            >
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Cancel</span>
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar & Percentage */}
      <div className="mb-6 relative z-10">
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-3xl font-bold font-mono text-white">
            {percentage}%
          </span>
          <span className="text-xs text-slate-400 font-mono">
            {formatBytes(progress?.transferredBytes || 0)} / {formatBytes(progress?.totalBytes || 0)}
          </span>
        </div>

        <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-slate-800">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isComplete
                ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.5)]'
                : 'bg-gradient-to-r from-purple-500 via-indigo-500 to-cyan-400 shadow-[0_0_12px_rgba(168,85,247,0.5)]'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-3 relative z-10">
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-3 flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400">
            <Gauge className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] text-slate-500 block uppercase font-medium">
              {isSender ? 'Upload Speed' : 'Download Speed'}
            </span>
            <span className="text-sm font-semibold text-slate-200 font-mono">
              {isComplete ? 'Done' : formatSpeed(progress?.speedBytesPerSec || 0)}
            </span>
          </div>
        </div>

        <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-3 flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <span className="text-[11px] text-slate-500 block uppercase font-medium">Remaining</span>
            <span className="text-sm font-semibold text-slate-200 font-mono">
              {isComplete ? '0s' : formatTime(progress?.etaSeconds || 0)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
