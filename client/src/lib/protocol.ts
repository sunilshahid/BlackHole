export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface TransferManifest {
  type: 'MANIFEST';
  files: FileMetadata[];
  totalBytes: number;
  transferId: string;
  cipher?: 'aes-gcm' | 'chacha20';
}

export type ControlMessage =
  | TransferManifest
  | { type: 'FILE_START'; fileIndex: number; totalChunks: number }
  | { type: 'FILE_END'; fileIndex: number }
  | { type: 'TRANSFER_COMPLETE' }
  | { type: 'TRANSFER_ACK' }
  | { type: 'RTC_PING' }
  | { type: 'RTC_PONG' }
  | { type: 'TRANSFER_CANCEL'; reason?: string };

export const PACKET_TYPE_CHUNK = 0x01;
export const PACKET_TYPE_CONTROL = 0x02;

/**
 * Encodes a binary chunk with a 9-byte header:
 * [1 byte: PACKET_TYPE_CHUNK]
 * [4 bytes: Uint32 fileIndex]
 * [4 bytes: Uint32 chunkIndex]
 * [Rest: Encrypted payload]
 */
export function encodeChunkPacket(
  fileIndex: number,
  chunkIndex: number,
  encryptedPayload: ArrayBuffer
): Uint8Array {
  const headerSize = 9;
  const packet = new Uint8Array(headerSize + encryptedPayload.byteLength);
  const view = new DataView(packet.buffer);

  // 1 byte packet type
  view.setUint8(0, PACKET_TYPE_CHUNK);
  // 4 bytes fileIndex
  view.setUint32(1, fileIndex, false); // big-endian
  // 4 bytes chunkIndex
  view.setUint32(5, chunkIndex, false); // big-endian

  // Payload
  packet.set(new Uint8Array(encryptedPayload), headerSize);

  return packet;
}

/**
 * Decodes a binary packet into its constituent parts
 */
export function decodePacket(buffer: ArrayBuffer):
  | { type: 'chunk'; fileIndex: number; chunkIndex: number; payload: ArrayBuffer }
  | { type: 'control'; message: ControlMessage }
  | { type: 'unknown' } {
  const view = new DataView(buffer);
  const packetType = view.getUint8(0);

  if (packetType === PACKET_TYPE_CHUNK) {
    if (buffer.byteLength < 9) return { type: 'unknown' };
    const fileIndex = view.getUint32(1, false);
    const chunkIndex = view.getUint32(5, false);
    const payload = buffer.slice(9);
    return { type: 'chunk', fileIndex, chunkIndex, payload };
  }

  if (packetType === PACKET_TYPE_CONTROL) {
    const jsonBytes = new Uint8Array(buffer, 1);
    const decoder = new TextDecoder();
    try {
      const message = JSON.parse(decoder.decode(jsonBytes)) as ControlMessage;
      return { type: 'control', message };
    } catch {
      return { type: 'unknown' };
    }
  }

  return { type: 'unknown' };
}

/**
 * Encodes a JSON control message into a binary packet
 */
export function encodeControlPacket(message: ControlMessage): Uint8Array {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(message));
  const packet = new Uint8Array(1 + jsonBytes.byteLength);
  packet[0] = PACKET_TYPE_CONTROL;
  packet.set(jsonBytes, 1);
  return packet;
}
