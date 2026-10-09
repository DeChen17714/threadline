import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';

export interface SendRoomMessageInput {
  readonly roomId: string;
  readonly messageId: string;
  readonly text: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 4000;
const MAX_TEXT_BYTES = 16384;
const MAX_SENDS_PER_MINUTE = 20;

export async function handleSendRoomMessage(
  db: Firestore,
  callerUid: string,
  callerLabel: string,
  requestId: string,
  input: SendRoomMessageInput
): Promise<CommandResult> {
  // 1. Strict input validation
  if (!UUID_REGEX.test(input.roomId) || !UUID_REGEX.test(input.messageId)) {
    throw createSafeAppError('validation', 'Invalid roomId or messageId format', requestId);
  }

  const trimmedText = input.text.trim();
  if (
    input.text.length < 1 ||
    input.text.length > MAX_TEXT_LENGTH ||
    trimmedText.length === 0 ||
    Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw createSafeAppError(
      'validation',
      'Message text must be non-blank, at most 4000 characters and 16 KiB',
      requestId
    );
  }

  const receiptId = `${callerUid}_sendRoomMessage_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
    messageId: input.messageId,
    text: input.text,
  });

  const bucketId = `sendRoomMessage_${callerUid}`;

  return await db.runTransaction(async (transaction) => {
    const now = Date.now();
    const windowStartMs = Math.floor(now / 60_000) * 60_000;
    const nextWindowMs = windowStartMs + 60_000;
    const receiptRef = db.collection('receipts').doc(receiptId);
    const roomRef = db.collection('rooms').doc(input.roomId);
    const messageRef = roomRef.collection('messages').doc(input.messageId);
    const bucketRef = db.collection('quotaBuckets').doc(bucketId);

    // Read room + receipt + message/counter before writes
    const [receiptSnap, roomSnap, messageSnap, bucketSnap] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(roomRef),
      transaction.get(messageRef),
      transaction.get(bucketRef),
    ]);

    // Handle receipt replay and payload conflicts
    if (receiptSnap.exists) {
      const receiptData = receiptSnap.data()!;
      if (receiptData.payloadHash !== canonicalPayloadHash) {
        throw createSafeAppError(
          'conflict',
          'Request ID already used with different payload',
          requestId,
          receiptId
        );
      }

      // Replay authorizes current active membership on active room
      if (!roomSnap.exists) {
        throw createSafeAppError('forbidden', 'Room no longer exists', requestId, receiptId);
      }

      const roomData = roomSnap.data()!;
      const rawMemberIds = roomData.memberIds;
      const memberIds = Array.isArray(rawMemberIds)
        ? rawMemberIds.filter((id): id is string => typeof id === 'string')
        : [];

      if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
      }

      // Returns IDs/seq only
      return {
        operationId: typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId,
        status: (receiptData.status as OperationStatus) || 'complete',
        roomId: (receiptData.roomId as string) || input.roomId,
        messageId: (receiptData.messageId as string) || input.messageId,
        seq: typeof receiptData.seq === 'number' ? receiptData.seq : undefined,
      };
    }

    // Verify room existence and active membership for fresh send
    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room not found', requestId, receiptId);
    }

    const roomData = roomSnap.data()!;
    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (roomData.state !== 'active') {
      throw createSafeAppError('forbidden', 'Room is not active', requestId, receiptId);
    }

    if (!memberIds.includes(callerUid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
    }

    if (roomData.maintenanceId) {
      throw createSafeAppError(
        'room-busy',
        'Updating conversation context. Keep your draft and send again when it finishes.',
        requestId,
        receiptId
      );
    }

    // Existing messageId without matching receipt must conflict (including different request ID)
    if (messageSnap.exists) {
      throw createSafeAppError(
        'conflict',
        'Message ID already exists',
        requestId,
        receiptId
      );
    }

    // Durable UID-minute rate limit: 20 accepted sends per UID per fixed server minute across rooms
    const currentBucketCount = bucketSnap.data()?.windowStartMs === windowStartMs ? (Number(bucketSnap.data()?.count) || 0) : 0;
    if (currentBucketCount >= MAX_SENDS_PER_MINUTE) {
      throw createSafeAppError(
        'throttled',
        'Message rate limit exceeded. Maximum 20 sends per minute.',
        requestId,
        receiptId,
        nextWindowMs
      );
    }

    // Sequence allocation: strictly monotonic and gapless per room
    const nextSeq = roomData.nextSeq;
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) {
      throw createSafeAppError('conflict', 'Room sequence is unavailable.', requestId, receiptId);
    }

    // Writes begin here (strictly after all reads above)
    // 1. Message document (immutable human kind, room intent, version 1, server timestamp)
    transaction.set(messageRef, {
      id: input.messageId,
      roomId: input.roomId,
      seq: nextSeq,
      text: input.text,
      kind: 'human',
      authorId: callerUid,
      authorLabel: callerLabel,
      intent: 'room',
      version: 1,
      createdAt: FieldValue.serverTimestamp(),
      editedAt: null,
      deletedAt: null,
    });

    transaction.update(roomRef, {
      nextSeq: nextSeq + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 3. Text-free private receipt
    transaction.set(receiptRef, {
      operationId: receiptId,
      operation: 'sendRoomMessage',
      callerUid,
      roomId: input.roomId,
      messageId: input.messageId,
      seq: nextSeq,
      payloadHash: canonicalPayloadHash,
      status: 'complete' as OperationStatus,
      createdAt: FieldValue.serverTimestamp(),
    });

    // 4. Increment durable UID-minute quota bucket
    if (bucketSnap.exists) {
      transaction.update(bucketRef, {
        windowStartMs,
        count: currentBucketCount + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      transaction.set(bucketRef, {
        uid: callerUid,
        windowStartMs,
        count: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      operationId: receiptId,
      status: 'complete' as OperationStatus,
      roomId: input.roomId,
      messageId: input.messageId,
      seq: nextSeq,
    };
  });
}
