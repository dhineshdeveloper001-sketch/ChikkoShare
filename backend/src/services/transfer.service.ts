import { db } from '../config/db';
import { v4 as uuidv4 } from 'uuid';
import { TRANSFER_CONFIG } from '../config/env';

export interface TransferRecord {
  id: string;
  room_id: string;
  filename: string;
  size: number;
  bucket_key: string;
  status: 'uploading' | 'complete' | 'expired' | 'deleted';
  expires_at: number;
  download_token: string;
  network_mode: string;
  created_at: number;
  downloaded_at: number | null;
}

export interface CreateTransferInput {
  roomId: string;
  filename: string;
  size: number;
  bucketKey: string;
  networkMode?: string;
}

// ── Create a pending transfer record ──────────────────────────────────────────
export function createTransfer(input: CreateTransferInput): TransferRecord {
  const id            = uuidv4();
  const downloadToken = uuidv4();
  const now           = Date.now();
  const expiresAt     = now + TRANSFER_CONFIG.deleteAbandonedAfterMs;

  db.prepare(`
    INSERT INTO transfers (id, room_id, filename, size, bucket_key, status, expires_at, download_token, network_mode, created_at)
    VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)
  `).run(id, input.roomId, input.filename, input.size, input.bucketKey, expiresAt, downloadToken, input.networkMode ?? 'cloud', now);

  return getByToken(downloadToken)!;
}

// ── Mark as complete and set shorter expiry ───────────────────────────────────
export function markComplete(id: string): void {
  const expiresAt = Date.now() + TRANSFER_CONFIG.deleteAfterDownloadMs;
  db.prepare(`UPDATE transfers SET status = 'complete', expires_at = ? WHERE id = ?`).run(expiresAt, id);
}

// ── Record download timestamp ─────────────────────────────────────────────────
export function recordDownload(id: string): void {
  db.prepare(`UPDATE transfers SET downloaded_at = ? WHERE id = ?`).run(Date.now(), id);
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function getByToken(token: string): TransferRecord | null {
  return db.prepare<string, TransferRecord>(`SELECT * FROM transfers WHERE download_token = ?`).get(token) ?? null;
}

export function getByRoomId(roomId: string): TransferRecord[] {
  return db.prepare<string, TransferRecord>(`SELECT * FROM transfers WHERE room_id = ? ORDER BY created_at DESC`).all(roomId);
}

export function getExpired(): TransferRecord[] {
  const now = Date.now();
  return db.prepare<number, TransferRecord>(`SELECT * FROM transfers WHERE expires_at < ? AND status != 'deleted'`).all(now);
}

export function markDeleted(id: string): void {
  db.prepare(`UPDATE transfers SET status = 'deleted' WHERE id = ?`).run(id);
}

export function deleteById(id: string): void {
  db.prepare(`DELETE FROM transfers WHERE id = ?`).run(id);
}

export function getRecentCompleted(limit = 50): TransferRecord[] {
  return db.prepare<number, TransferRecord>(`
    SELECT * FROM transfers 
    WHERE status IN ('complete', 'deleted')
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(limit);
}
