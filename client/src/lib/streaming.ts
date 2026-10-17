import {
  type FileMetadata,
  type TransferManifest,
  encodeChunkPacket,
  encodeControlPacket,
  decodePacket,
} from './protocol';
import { encryptChunk, decryptChunk, type BlackHoleKey, type CipherType } from './crypto';

// 32 KB chunk size guarantees total packet stays well under the 65,535-byte WebRTC/SCTP limit
export const CHUNK_SIZE = 32 * 1024;

export interface TransferProgress {
  totalBytes: number;
  transferredBytes: number;
  currentFileIndex: number;
  currentFileName: string;
  percentage: number;
  speedBytesPerSec: number;
  etaSeconds: number;
}

export interface ReceivedFile {
  metadata: FileMetadata;
  blob: Blob;
  downloadUrl: string;
}

export interface PacketTransport {
  sendPacket: (data: Uint8Array) => Promise<void>;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

import { logger } from './logger';

/**
 * File Sender Engine
 */
export async function sendFiles(
  files: File[],
  transport: PacketTransport,
  cryptoKey: BlackHoleKey,
  onProgress: (p: TransferProgress) => void,
  isCancelled: () => boolean
): Promise<void> {
  const metadataList: FileMetadata[] = files.map((f, idx) => ({
    id: `file_${idx}_${Date.now()}`,
    name: f.name,
    size: f.size,
    type: f.type || 'application/octet-stream',
    lastModified: f.lastModified,
  }));

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  let transferredBytes = 0;
  const startTime = Date.now();
  let lastProgressUpdate = startTime;
  let lastLogTime = startTime;
  let lastTransferredBytes = 0;
  let rollingSpeed = 0;
  const chosenCipher: CipherType = cryptoKey.preferredCipher;

  logger.info('STREAM', `Starting stream: ${files.length} file(s), total ${formatBytes(totalBytes)}, cipher: ${chosenCipher.toUpperCase()}`);

  // 1. Send manifest
  const manifest: TransferManifest = {
    type: 'MANIFEST',
    files: metadataList,
    totalBytes,
    transferId: `transfer_${Date.now()}`,
    cipher: chosenCipher,
  };

  await transport.sendPacket(encodeControlPacket(manifest));

  // 2. Iterate each file
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    if (isCancelled()) {
      logger.warn('STREAM', 'Transfer cancelled by user');
      break;
    }

    const file = files[fileIdx];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    logger.info('STREAM', `Streaming file #${fileIdx + 1}/${files.length}: "${file.name}" (${formatBytes(file.size)}, ${totalChunks} chunks)`);

    // Notify start of file
    await transport.sendPacket(
      encodeControlPacket({
        type: 'FILE_START',
        fileIndex: fileIdx,
        totalChunks,
      })
    );

    // Read files in 1 MB blocks to minimize mobile disk seek / ContentResolver IPC overhead
    const READ_BLOCK_SIZE = 1024 * 1024; // 1 MB (32 chunks of 32 KB)

    const readAndEncryptBlock = async (blockStartOffset: number, startChunkIdx: number) => {
      const blockSlice = file.slice(blockStartOffset, blockStartOffset + READ_BLOCK_SIZE);
      const blockBuffer = await blockSlice.arrayBuffer();

      const promises: Promise<Uint8Array>[] = [];
      let curIdx = startChunkIdx;
      let batchBytes = 0;

      for (let chunkOffset = 0; chunkOffset < blockBuffer.byteLength; chunkOffset += CHUNK_SIZE) {
        const curChunkSize = Math.min(CHUNK_SIZE, blockBuffer.byteLength - chunkOffset);
        const rawChunk = blockBuffer.slice(chunkOffset, chunkOffset + curChunkSize);
        const thisChunkIdx = curIdx++;
        batchBytes += curChunkSize;

        promises.push(
          encryptChunk(cryptoKey, rawChunk, chosenCipher).then((encrypted) =>
            encodeChunkPacket(fileIdx, thisChunkIdx, encrypted)
          )
        );
      }

      const packets = await Promise.all(promises);
      return {
        packets,
        totalBatchBytes: batchBytes,
        nextOffset: blockStartOffset + blockBuffer.byteLength,
        nextChunkIdx: curIdx,
      };
    };

    let offset = 0;
    let chunkIdx = 0;
    let nextBlockPromise = readAndEncryptBlock(offset, chunkIdx);

    while (offset < file.size) {
      if (isCancelled()) {
        logger.warn('STREAM', 'Transfer cancelled by user');
        break;
      }

      const currentBlock = await nextBlockPromise;
      offset = currentBlock.nextOffset;
      chunkIdx = currentBlock.nextChunkIdx;

      // Pipeline read-ahead: Asynchronously start reading & encrypting the NEXT 1MB block immediately!
      if (offset < file.size && !isCancelled()) {
        nextBlockPromise = readAndEncryptBlock(offset, chunkIdx);
      }

      // Stream current batch over the wire without any delay!
      for (let i = 0; i < currentBlock.packets.length; i++) {
        if (isCancelled()) break;
        try {
          await transport.sendPacket(currentBlock.packets[i]);
        } catch (err) {
          if (isCancelled()) break;
          throw err;
        }
      }
      transferredBytes += currentBlock.totalBatchBytes;

      // Compute instantaneous rolling speed and ETA
      const now = Date.now();
      if (now - lastProgressUpdate > 100 || transferredBytes === totalBytes) {
        const timeDiff = (now - lastProgressUpdate) / 1000;
        const bytesDiff = transferredBytes - lastTransferredBytes;
        const instantSpeed = timeDiff > 0 ? bytesDiff / timeDiff : 0;
        rollingSpeed = rollingSpeed === 0 ? instantSpeed : rollingSpeed * 0.7 + instantSpeed * 0.3;

        lastProgressUpdate = now;
        lastTransferredBytes = transferredBytes;

        const remainingBytes = totalBytes - transferredBytes;
        const eta = rollingSpeed > 0 ? remainingBytes / rollingSpeed : 0;

        const percentage = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 100;

        // Periodic diagnostic log (every 750ms)
        if (now - lastLogTime > 750 || transferredBytes === totalBytes) {
          lastLogTime = now;
          logger.info('SPEED', `[Sender] ${percentage}% (${formatBytes(transferredBytes)}/${formatBytes(totalBytes)}) @ ${formatSpeed(rollingSpeed)} (Instant: ${formatSpeed(instantSpeed)}) ETA: ${formatTime(eta)}`);
          logger.updateSpeed(instantSpeed, rollingSpeed, transferredBytes);
        }

        onProgress({
          totalBytes,
          transferredBytes,
          currentFileIndex: fileIdx,
          currentFileName: file.name,
          percentage,
          speedBytesPerSec: rollingSpeed,
          etaSeconds: Math.ceil(eta),
        });
      }
    }

    // Notify end of file
    await transport.sendPacket(
      encodeControlPacket({
        type: 'FILE_END',
        fileIndex: fileIdx,
      })
    );
    logger.success('STREAM', `Delivered file #${fileIdx + 1} "${file.name}"`);
  }

  if (!isCancelled()) {
    await transport.sendPacket(encodeControlPacket({ type: 'TRANSFER_COMPLETE' }));
    logger.success('STREAM', `All ${files.length} files successfully sent! Total: ${formatBytes(totalBytes)}`);
  }
}

/**
 * File Receiver Engine
 */
export class FileReceiver {
  private cryptoKey: BlackHoleKey;
  private cipher: CipherType = 'aes-gcm';
  private manifest: TransferManifest | null = null;
  private incomingChunks = new Map<number, { chunks: ArrayBuffer[]; receivedBytes: number }>();
  public receivedFiles: ReceivedFile[] = [];

  private totalBytes = 0;
  private transferredBytes = 0;
  private startTime = 0;
  private lastUpdate = 0;
  private lastTransferredBytes = 0;
  private rollingSpeed = 0;

  private lastLogTime = 0;

  private onProgress: (p: TransferProgress) => void;
  private onFileReady: (file: ReceivedFile) => void;
  private onComplete: () => void;

  constructor(
    cryptoKey: BlackHoleKey,
    onProgress: (p: TransferProgress) => void,
    onFileReady: (file: ReceivedFile) => void,
    onComplete: () => void
  ) {
    this.cryptoKey = cryptoKey;
    this.cipher = cryptoKey.preferredCipher;
    this.onProgress = onProgress;
    this.onFileReady = onFileReady;
    this.onComplete = onComplete;
  }

  public async handlePacket(buffer: ArrayBuffer) {
    const packet = decodePacket(buffer);

    if (packet.type === 'control') {
      const msg = packet.message;

      if (msg.type === 'MANIFEST') {
        this.manifest = msg;
        this.totalBytes = msg.totalBytes;
        this.cipher = msg.cipher || 'aes-gcm';
        this.transferredBytes = 0;
        this.startTime = Date.now();
        this.lastUpdate = this.startTime;
        this.lastLogTime = this.startTime;
        logger.info('STREAM', `Receiver received Manifest: ${msg.files.length} file(s), total ${formatBytes(msg.totalBytes)}, cipher: ${this.cipher.toUpperCase()}`);
        logger.setCipher(this.cipher === 'aes-gcm' ? 'Hardware AES-256-GCM (WebCrypto)' : 'Pure JS ChaCha20');
      } else if (msg.type === 'FILE_START') {
        this.incomingChunks.set(msg.fileIndex, { chunks: [], receivedBytes: 0 });
        const name = this.manifest?.files[msg.fileIndex]?.name || `File #${msg.fileIndex + 1}`;
        logger.info('STREAM', `Receiving stream for "${name}" (${msg.totalChunks} chunks)`);
      } else if (msg.type === 'FILE_END') {
        await this.finalizeFile(msg.fileIndex);
      } else if (msg.type === 'TRANSFER_COMPLETE') {
        logger.success('STREAM', `All received files verified and ready! Total: ${formatBytes(this.totalBytes)}`);
        this.onComplete();
      }
    } else if (packet.type === 'chunk') {
      const { fileIndex, chunkIndex, payload } = packet;

      // Decrypt chunk with negotiated cipher
      const decrypted = await decryptChunk(this.cryptoKey, payload, this.cipher);

      const fileState = this.incomingChunks.get(fileIndex);
      if (fileState) {
        fileState.chunks[chunkIndex] = decrypted;
        fileState.receivedBytes += decrypted.byteLength;
        this.transferredBytes += decrypted.byteLength;

        // Instantaneous rolling speed calculation
        const now = Date.now();
        if (now - this.lastUpdate > 100 || this.transferredBytes === this.totalBytes) {
          const timeDiff = (now - this.lastUpdate) / 1000;
          const bytesDiff = this.transferredBytes - this.lastTransferredBytes;
          const instantSpeed = timeDiff > 0 ? bytesDiff / timeDiff : 0;
          this.rollingSpeed = this.rollingSpeed === 0 ? instantSpeed : this.rollingSpeed * 0.7 + instantSpeed * 0.3;

          this.lastUpdate = now;
          this.lastTransferredBytes = this.transferredBytes;

          const remainingBytes = this.totalBytes - this.transferredBytes;
          const eta = this.rollingSpeed > 0 ? remainingBytes / this.rollingSpeed : 0;

          const currentFileName = this.manifest?.files[fileIndex]?.name || 'Receiving...';
          const percentage = this.totalBytes > 0
            ? Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 100))
            : 100;

          // Diagnostic periodic log (every 750ms)
          if (now - this.lastLogTime > 750 || this.transferredBytes === this.totalBytes) {
            this.lastLogTime = now;
            logger.info('SPEED', `[Receiver] ${percentage}% (${formatBytes(this.transferredBytes)}/${formatBytes(this.totalBytes)}) @ ${formatSpeed(this.rollingSpeed)} (Instant: ${formatSpeed(instantSpeed)}) ETA: ${formatTime(eta)}`);
            logger.updateSpeed(instantSpeed, this.rollingSpeed, this.transferredBytes);
          }

          this.onProgress({
            totalBytes: this.totalBytes,
            transferredBytes: this.transferredBytes,
            currentFileIndex: fileIndex,
            currentFileName,
            percentage,
            speedBytesPerSec: this.rollingSpeed,
            etaSeconds: Math.ceil(eta),
          });
        }
      }
    }
  }

  private async finalizeFile(fileIndex: number) {
    const fileState = this.incomingChunks.get(fileIndex);
    if (!fileState || !this.manifest) return;

    const meta = this.manifest.files[fileIndex];
    if (!meta) return;

    const blob = new Blob(fileState.chunks, { type: meta.type });
    const downloadUrl = URL.createObjectURL(blob);

    const received: ReceivedFile = {
      metadata: meta,
      blob,
      downloadUrl,
    };

    this.receivedFiles.push(received);
    this.incomingChunks.delete(fileIndex); // free raw chunk buffers
    logger.success('STREAM', `Receiver assembled file "${meta.name}" (${formatBytes(meta.size)})`);
    this.onFileReady(received);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatTime(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}
