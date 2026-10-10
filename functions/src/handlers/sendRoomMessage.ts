import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';
import type { ModerationPort } from '../moderation/provider.js';
import {
  SUBMISSION_LEASE_MS, SCREENING_BLOCKED_MESSAGE, SCREENING_UNAVAILABLE_MESSAGE,
  executeScreening, isLiveSubmission, settleSubmissionFailure, submissionReceiptResult,
} from '../moderation/submissions.js';

export interface SendRoomMessageInput {
  readonly roomId: string;
  readonly messageId: string;
  readonly text: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SENDS_PER_MINUTE = 20;

export async function handleSendRoomMessage(
  db: Firestore,
  callerUid: string,
  callerLabel: string,
  requestId: string,
  input: SendRoomMessageInput,
  moderation: ModerationPort
): Promise<CommandResult> {
  if (!UUID_REGEX.test(input.roomId) || !UUID_REGEX.test(input.messageId)) {
    throw createSafeAppError('validation', 'Invalid roomId or messageId format', requestId);
  }
  if (typeof input.text !== 'string' || input.text.length > 4000 || !input.text.trim() ||
      Buffer.byteLength(input.text, 'utf8') > 16384) {
    throw createSafeAppError('validation', 'Message text must be non-blank, at most 4000 characters and 16 KiB', requestId);
  }
  const receiptId = `${callerUid}_sendRoomMessage_${requestId}`;
  const payloadHash = computePayloadHash({ roomId: input.roomId, messageId: input.messageId, text: input.text });
  const receiptRef = db.collection('receipts').doc(receiptId);
  const submissionRef = db.collection('submissions').doc(receiptId);
  const roomRef = db.collection('rooms').doc(input.roomId);
  const messageRef = roomRef.collection('messages').doc(input.messageId);
  const bucketRef = db.collection('quotaBuckets').doc(`sendRoomMessage_${callerUid}`);
  const finish = (result: CommandResult): CommandResult => {
    if (result.status === 'failed') {
      const code = result.errorCode === 'screening-blocked' ? 'screening-blocked' : 'screening-unavailable';
      throw createSafeAppError(code, code === 'screening-blocked' ? SCREENING_BLOCKED_MESSAGE : SCREENING_UNAVAILABLE_MESSAGE, requestId, receiptId);
    }
    return result;
  };

  // The same transaction invariants govern admission and settlement. Only admission
  // can create a claim; a late callback can never recreate a deleted one.
  const transact = (verdict?: 'allow' | 'block' | 'unavailable') => db.runTransaction(async (transaction) => {
    const [receiptSnap, submissionSnap, roomSnap, messageSnap, bucketSnap] = await Promise.all([
      transaction.get(receiptRef), transaction.get(submissionRef), transaction.get(roomRef),
      transaction.get(messageRef), transaction.get(bucketRef),
    ]);
    const room = roomSnap.data();
    const now = Date.now();
    const windowStartMs = Math.floor(now / 60_000) * 60_000;
    const count = bucketSnap.data()?.windowStartMs === windowStartMs ? Number(bucketSnap.data()?.count) || 0 : 0;
    // All throwing validation precedes publication writes. On a final-pass conflict,
    // commit a terminal private receipt before propagating the original safe error.
    try {
      if (!room || room.state !== 'active' || !Array.isArray(room.memberIds) || !room.memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
      }
      if (receiptSnap.exists) {
        const receipt = receiptSnap.data()!;
        if (receipt.callerUid !== callerUid || receipt.payloadHash !== payloadHash || receipt.roomId !== input.roomId ||
            receipt.operation !== 'sendRoomMessage' || receipt.messageId !== input.messageId) {
          throw createSafeAppError('conflict', 'Request ID already used with different payload', requestId, receiptId);
        }
        return { result: submissionReceiptResult(receipt, receiptId) };
      }
      const sub = submissionSnap.data();
      if (sub && (sub.callerUid !== callerUid || sub.payloadHash !== payloadHash || sub.roomId !== input.roomId ||
          sub.messageId !== input.messageId || sub.operation !== 'sendRoomMessage')) {
        throw createSafeAppError('conflict', 'Invalid submission claim', requestId, receiptId);
      }
      if (sub || verdict !== undefined) {
        if (!isLiveSubmission(sub, callerUid, payloadHash, now)) {
          return { result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, payloadHash) };
        }
        if (verdict === undefined) {
          return { result: { operationId: receiptId, status: 'pending' as const, roomId: input.roomId, messageId: input.messageId } };
        }
        if (verdict !== 'allow') {
          return { result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, payloadHash,
            verdict === 'block' ? 'screening-blocked' : 'screening-unavailable') };
        }
      }
      if (room.maintenanceId) {
        throw createSafeAppError('room-busy', 'Updating conversation context. Keep your draft and send again when it finishes.', requestId, receiptId);
      }
      if (messageSnap.exists) throw createSafeAppError('conflict', 'Message ID already exists', requestId, receiptId);
      if (count >= MAX_SENDS_PER_MINUTE) {
        throw createSafeAppError('throttled', 'Message rate limit exceeded. Maximum 20 sends per minute.', requestId, receiptId, windowStartMs + 60_000);
      }
      if (!Number.isSafeInteger(room.nextSeq) || room.nextSeq < 1) {
        throw createSafeAppError('conflict', 'Room sequence is unavailable.', requestId, receiptId);
      }
    } catch (error) {
      if (verdict !== undefined && room?.state === 'active') {
        settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, payloadHash);
      }
      return { error };
    }
    if (verdict === undefined) {
      transaction.create(submissionRef, {
        id: receiptId, operation: 'sendRoomMessage', callerUid, roomId: input.roomId,
        messageId: input.messageId, payloadHash, state: 'pending', leaseExpiresAt: now + SUBMISSION_LEASE_MS,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { claimed: true as const };
    }
    const seq = room!.nextSeq;
    transaction.create(messageRef, {
      id: input.messageId, roomId: input.roomId, seq, text: input.text, kind: 'human', authorId: callerUid,
      authorLabel: callerLabel, intent: 'room', version: 1, createdAt: FieldValue.serverTimestamp(), editedAt: null, deletedAt: null,
    });
    transaction.update(roomRef, { nextSeq: seq + 1, updatedAt: FieldValue.serverTimestamp() });
    transaction.delete(submissionRef);
    transaction.create(receiptRef, {
      operationId: receiptId, operation: 'sendRoomMessage', callerUid, roomId: input.roomId,
      messageId: input.messageId, seq, payloadHash, status: 'complete', createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(bucketRef, {
      uid: callerUid, windowStartMs, count: count + 1, updatedAt: FieldValue.serverTimestamp(),
      ...(!bucketSnap.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
    }, { merge: true });
    return { result: { operationId: receiptId, status: 'complete' as const, roomId: input.roomId, messageId: input.messageId, seq } };
  });
  const admission = await transact();
  if ('error' in admission) throw admission.error;
  if (admission.result) return finish(admission.result);
  const screen = await executeScreening(moderation, input.text);
  const settlement = await transact(screen.verdict);
  if ('error' in settlement) throw settlement.error;
  return finish(settlement.result!);
}
