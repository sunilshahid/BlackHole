import { WebSocket } from 'ws';

export interface RoomPeer {
  id: string;
  ws: WebSocket;
  role: 'sender' | 'receiver';
}

export interface Room {
  id: string;
  code: string;
  sender?: RoomPeer;
  receiver?: RoomPeer;
  createdAt: number;
}

export class RoomManager {
  private roomsByCode = new Map<string, Room>();
  private roomsById = new Map<string, Room>();
  private peerToRoom = new Map<WebSocket, { roomId: string; role: 'sender' | 'receiver' }>();

  normalizeCode(code: string): string {
    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length === 6) {
      return `${clean.slice(0, 3)}-${clean.slice(3)}`;
    }
    return code.trim().toUpperCase();
  }

  // Generate a clean 6-character alphanumeric code: e.g. 7K9-X2M
  generateCode(): string {
    const chars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    let code: string;
    let attempts = 0;
    do {
      let p1 = '';
      let p2 = '';
      for (let i = 0; i < 3; i++) {
        p1 += chars[Math.floor(Math.random() * chars.length)];
        p2 += chars[Math.floor(Math.random() * chars.length)];
      }
      code = `${p1}-${p2}`;
      attempts++;
    } while (this.roomsByCode.has(code) && attempts < 100);

    return code;
  }

  createRoom(ws: WebSocket, customCode?: string): Room {
    const id = `room_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const code = customCode ? this.normalizeCode(customCode) : this.generateCode();

    // Clean up existing room with same code if empty or stale
    const existing = this.roomsByCode.get(code);
    if (existing) {
      this.closeRoom(existing.id);
    }

    const room: Room = {
      id,
      code,
      sender: {
        id: `peer_${Math.random().toString(36).substring(2, 8)}`,
        ws,
        role: 'sender',
      },
      createdAt: Date.now(),
    };

    this.roomsByCode.set(code, room);
    this.roomsById.set(id, room);
    this.peerToRoom.set(ws, { roomId: id, role: 'sender' });

    return room;
  }

  joinRoom(ws: WebSocket, code: string): { success: boolean; room?: Room; error?: string } {
    const formattedCode = this.normalizeCode(code);
    let room = this.roomsByCode.get(formattedCode);

    if (!room) {
      // Fallback: check raw trim
      room = this.roomsByCode.get(code.trim().toUpperCase());
    }

    if (!room) {
      return { success: false, error: 'Room not found. Please check the code.' };
    }

    if (!room.sender || room.sender.ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'The sender is no longer connected.' };
    }

    room.receiver = {
      id: `peer_${Math.random().toString(36).substring(2, 8)}`,
      ws,
      role: 'receiver',
    };

    this.peerToRoom.set(ws, { roomId: room.id, role: 'receiver' });

    return { success: true, room };
  }

  getRoomByWs(ws: WebSocket): Room | undefined {
    const info = this.peerToRoom.get(ws);
    if (!info) return undefined;
    return this.roomsById.get(info.roomId);
  }

  handleDisconnect(ws: WebSocket): { affectedRoom?: Room; role?: 'sender' | 'receiver' } {
    const info = this.peerToRoom.get(ws);
    if (!info) return {};

    const room = this.roomsById.get(info.roomId);
    this.peerToRoom.delete(ws);

    if (!room) return {};

    if (info.role === 'sender') {
      if (room.receiver && room.receiver.ws.readyState === WebSocket.OPEN) {
        room.receiver.ws.send(JSON.stringify({ type: 'peer-disconnected', message: 'Sender disconnected' }));
      }
      this.closeRoom(room.id);
      return { affectedRoom: room, role: 'sender' };
    } else {
      room.receiver = undefined;
      if (room.sender && room.sender.ws.readyState === WebSocket.OPEN) {
        room.sender.ws.send(JSON.stringify({ type: 'peer-disconnected', message: 'Receiver disconnected' }));
      }
      return { affectedRoom: room, role: 'receiver' };
    }
  }

  closeRoom(roomId: string) {
    const room = this.roomsById.get(roomId);
    if (!room) return;

    this.roomsByCode.delete(room.code);
    this.roomsById.delete(roomId);
    if (room.sender) this.peerToRoom.delete(room.sender.ws);
    if (room.receiver) this.peerToRoom.delete(room.receiver.ws);
  }
}
