import { FieldValue, type Firestore, type Transaction, type DocumentReference } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';

export interface EditMessageInput {
  readonly roomId: string;
  readonly messageId: string;
  readonly expectedVersion: number;
  readonly text: string;
}

export interface DeleteMessageInput {
  readonly roomId: string;
  readonly messageId: string;
  readonly expectedVersion: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 4000;
const MAX_TEXT_BYTES = 16384;

async function executeMessageMutation(
  db: Firestore,
  callerUid: string,
  requestId: string,
  kind: 'edit' | 'delete',
  input: { roomId: string; messageId: string; expectedVersion: number },
  canonicalPayloadHash: string,
  applyMutationWrites: (
    transaction: Transaction,
    messageRef: DocumentReference,
    nextVersion: number,
    now: FieldValue
  ) => void
): Promise<CommandResult> {
  const receiptId = `${callerUid}_${kind}Message_${requestId}`;

  return await db.runTransaction(async (transaction) => {
    const receiptRef = db.collection('receipts').doc(receiptId);
    const roomRef = db.collection('rooms').doc(input.roomId);
    const messageRef = roomRef.collection('messages').doc(input.messageId);

    // Read receipt, room, and message strictly before any writes
    const [receiptSnap, roomSnap, messageSnap] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(roomRef),
      transaction.get(messageRef),
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

      return {
        operationId: typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId,
        status: (receiptData.status as OperationStatus) || 'complete',
        roomId: (receiptData.roomId as string) || input.roomId,
        messageId: (receiptData.messageId as string) || input.messageId,
        version: typeof receiptData.version === 'number' ? receiptData.version : undefined,
      };
    }

    // Verify room existence and active membership for fresh mutation
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

    // Concurrency guard: pause mutations if room is busy with maintenance or inference
    if (roomData.maintenanceId || roomData.activeGenerationId) {
      throw createSafeAppError(
        'room-busy',
        'Room is busy. Keep your draft and try again when it settles.',
        requestId,
        receiptId
      );
    }

    // Message existence and author checks
    if (!messageSnap.exists) {
      throw createSafeAppError('missing', 'Message not found', requestId, receiptId);
    }

    const messageData = messageSnap.data()!;

    if (messageData.kind !== 'human') {
      throw createSafeAppError(
        'forbidden',
        `Only human messages can be ${kind === 'edit' ? 'edited' : 'deleted'}`,
        requestId,
        receiptId
      );
    }

    if (messageData.authorId !== callerUid) {
      throw createSafeAppError(
        'forbidden',
        `Only the author can ${kind === 'edit' ? 'edit' : 'delete'} this message`,
        requestId,
        receiptId
      );
    }

    if (messageData.deletedAt) {
      throw createSafeAppError(
        'conflict',
        `Cannot ${kind === 'edit' ? 'edit' : 'delete'} a deleted message`,
        requestId,
        receiptId
      );
    }

    // Optimistic concurrency check
    const currentVersion = messageData.version;
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || currentVersion >= Number.MAX_SAFE_INTEGER) {
      throw createSafeAppError('conflict', 'Message version is unavailable', requestId, receiptId);
    }
    if (currentVersion !== input.expectedVersion) {
      throw createSafeAppError('conflict', 'Message version conflict', requestId, receiptId);
    }

    // Atomic version bump and maintenance job setup
    const nextVersion = currentVersion + 1;
    const editedSeq = messageData.seq;
    const highwaterSeq = roomData.nextSeq - 1;
    if (!Number.isSafeInteger(editedSeq) || editedSeq < 1 || !Number.isSafeInteger(highwaterSeq) || highwaterSeq < editedSeq) {
      throw createSafeAppError('conflict', 'Conversation range is unavailable', requestId, receiptId);
    }
    const jobId = `${callerUid}_invalidateContext_${requestId}`;
    const jobRef = db.collection('maintenanceJobs').doc(jobId);
    const now = FieldValue.serverTimestamp();

    // Writes begin here strictly after all reads above
    applyMutationWrites(transaction, messageRef, nextVersion, now);

    transaction.update(roomRef, {
      maintenanceId: jobId,
      maintenanceState: 'updating-context',
      updatedAt: now,
    });

    transaction.create(jobRef, {
      operationId: jobId,
      callerUid,
      roomId: input.roomId,
      messageId: input.messageId,
      targetVersion: nextVersion,
      mutationKind: kind,
      editedSeq,
      highwaterSeq,
      cursorSeq: editedSeq + 1,
      operation: 'invalidateContext',
      status: 'pending' as OperationStatus,
      invalidatedCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Text-free private receipt
    transaction.set(receiptRef, {
      operationId: receiptId,
      callerUid,
      operation: `${kind}Message`,
      requestId,
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
      payloadHash: canonicalPayloadHash,
      status: 'complete' as OperationStatus,
      createdAt: now,
    });

    return {
      operationId: receiptId,
      status: 'complete' as OperationStatus,
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
    };
  });
}

export async function handleEditMessage(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: EditMessageInput
): Promise<CommandResult> {
  // 1. Strict input validation
  if (!UUID_REGEX.test(input.roomId) || !UUID_REGEX.test(input.messageId)) {
    throw createSafeAppError('validation', 'Invalid roomId or messageId format', requestId);
  }

  if (
    typeof input.text !== 'string' ||
    input.text.length < 1 ||
    input.text.length > MAX_TEXT_LENGTH ||
    input.text.trim().length === 0 ||
    Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw createSafeAppError(
      'validation',
      'Message text must be non-blank, at most 4000 characters and 16 KiB',
      requestId
    );
  }

  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw createSafeAppError(
      'validation',
      'expectedVersion must be a positive integer',
      requestId
    );
  }

  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
    messageId: input.messageId,
    expectedVersion: input.expectedVersion,
    text: input.text,
  });

  return await executeMessageMutation(
    db,
    callerUid,
    requestId,
    'edit',
    input,
    canonicalPayloadHash,
    (transaction, messageRef, nextVersion, now) => {
      transaction.update(messageRef, {
        text: input.text,
        version: nextVersion,
        editedAt: now,
      });
    }
  );
}

export async function handleDeleteMessage(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: DeleteMessageInput
): Promise<CommandResult> {
  // 1. Strict input validation
  if (!UUID_REGEX.test(input.roomId) || !UUID_REGEX.test(input.messageId)) {
    throw createSafeAppError('validation', 'Invalid roomId or messageId format', requestId);
  }

  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw createSafeAppError(
      'validation',
      'expectedVersion must be a positive integer',
      requestId
    );
  }

  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
    messageId: input.messageId,
    expectedVersion: input.expectedVersion,
  });

  return await executeMessageMutation(
    db,
    callerUid,
    requestId,
    'delete',
    input,
    canonicalPayloadHash,
    (transaction, messageRef, nextVersion, now) => {
      transaction.update(messageRef, {
        text: '',
        version: nextVersion,
        deletedAt: now,
      });
    }
  );
}
