import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult } from '@threadline/shared';
import { createSafeAppError } from '../utils/errors.js';
import { settleReservation } from './lifecycle.js';

export async function handleRecoverGeneration(db: Firestore, uid: string, requestId: string,
  input: { roomId: string; generationId: string }): Promise<CommandResult> {
  const roomRef = db.collection('rooms').doc(input.roomId);
  const generationRef = roomRef.collection('generations').doc(input.generationId);
  const reservationRef = db.collection('reservations').doc(input.generationId);
  return db.runTransaction(async transaction => {
    const [roomSnap, generationSnap, reservationSnap] = await Promise.all([
      transaction.get(roomRef), transaction.get(generationRef), transaction.get(reservationRef),
    ]);
    const room = roomSnap.data(), generation = generationSnap.data();
    if (!room || room.state !== 'active' || !Array.isArray(room.memberIds) || !room.memberIds.includes(uid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room.', requestId);
    }
    if (!generation) throw createSafeAppError('missing', 'Generation unavailable.', requestId);
    if (!['preparing', 'dispatched'].includes(generation.state)) return {
      operationId: generation.receiptId, status: generation.state === 'succeeded' ? 'complete' : generation.state === 'cancelled' ? 'cancelled' : 'failed',
      roomId: input.roomId, messageId: generation.promptMessageId,
    };
    if (generation.expiresAt > Date.now()) return { operationId: generation.receiptId, status: 'pending', roomId: input.roomId, messageId: generation.promptMessageId };
    if (room.activeGenerationId !== input.generationId) throw createSafeAppError('conflict', 'Generation fence changed.', requestId);
    const receiptRef = db.collection('receipts').doc(generation.receiptId);
    const receiptSnap = await transaction.get(receiptRef);
    if (reservationSnap.exists && reservationSnap.data()!.state === 'reserved') {
      await settleReservation(transaction, db, reservationRef, reservationSnap.data()!, generation.state !== 'preparing');
    }
    transaction.update(generationRef, { state: 'timed-out', errorCode: 'timeout', finishedAt: FieldValue.serverTimestamp() });
    transaction.update(roomRef, { activeGenerationId: null });
    if (receiptSnap.exists) transaction.update(receiptRef, { status: 'failed' });
    return { operationId: generation.receiptId, status: 'failed', roomId: input.roomId, messageId: generation.promptMessageId };
  });
}
