import { FieldValue, type Firestore, type Transaction, type DocumentReference } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';
import type { ModerationPort } from '../moderation/provider.js';
import {
  SUBMISSION_LEASE_MS,
  SCREENING_BLOCKED_MESSAGE,
  SCREENING_UNAVAILABLE_MESSAGE,
  executeScreening,
  isLiveSubmission,
  settleSubmissionFailure,
  submissionReceiptResult,
} from '../moderation/submissions.js';
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
  input: EditMessageInput,
  moderation: ModerationPort
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

  const receiptId = `${callerUid}_editMessage_${requestId}`;
  const submissionId = receiptId;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
    messageId: input.messageId,
    expectedVersion: input.expectedVersion,
    text: input.text,
  });

  const finish = (result: CommandResult): CommandResult => {
    if (result.status === 'failed') {
      const code = result.errorCode === 'screening-blocked' ? 'screening-blocked' : 'screening-unavailable';
      throw createSafeAppError(code, code === 'screening-blocked' ? SCREENING_BLOCKED_MESSAGE : SCREENING_UNAVAILABLE_MESSAGE, requestId, receiptId);
    }
    return result;
  };
  const transact = (verdict?: 'allow' | 'block' | 'unavailable') => db.runTransaction(async (transaction) => {
    const receiptRef = db.collection('receipts').doc(receiptId);
    const submissionRef = db.collection('submissions').doc(submissionId);
    const roomRef = db.collection('rooms').doc(input.roomId);
    const messageRef = roomRef.collection('messages').doc(input.messageId);
    const [receiptSnap, submissionSnap, roomSnap, messageSnap] = await Promise.all([
      transaction.get(receiptRef), transaction.get(submissionRef), transaction.get(roomRef), transaction.get(messageRef),
    ]);
    const roomData = roomSnap.data();
    const messageData = messageSnap.data();
    try {
      if (!roomData || roomData.state !== 'active' || !Array.isArray(roomData.memberIds) || !roomData.memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
      }
      if (receiptSnap.exists) {
        const receipt = receiptSnap.data()!;
        if (receipt.callerUid !== callerUid || receipt.payloadHash !== canonicalPayloadHash || receipt.roomId !== input.roomId ||
            receipt.operation !== 'editMessage' || receipt.messageId !== input.messageId) {
          throw createSafeAppError('conflict', 'Request ID already used with different payload', requestId, receiptId);
        }
        return { result: submissionReceiptResult(receipt, receiptId) };
      }
      const sub = submissionSnap.data();
      if (sub && (sub.callerUid !== callerUid || sub.payloadHash !== canonicalPayloadHash ||
          sub.roomId !== input.roomId || sub.messageId !== input.messageId || sub.operation !== 'editMessage')) {
        throw createSafeAppError('conflict', 'Invalid submission claim', requestId, receiptId);
      }
      if (sub || verdict !== undefined) {
        if (!isLiveSubmission(sub, callerUid, canonicalPayloadHash)) {
          return { result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, canonicalPayloadHash) };
        }
        if (verdict === undefined) {
          return { result: { operationId: receiptId, status: 'pending' as const, roomId: input.roomId, messageId: input.messageId } };
        }
        if (verdict !== 'allow') {
          return { result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, canonicalPayloadHash,
            verdict === 'block' ? 'screening-blocked' : 'screening-unavailable') };
        }
      }
      if (roomData.maintenanceId || roomData.activeGenerationId) {
        throw createSafeAppError('room-busy', 'Room is busy. Keep your draft and try again when it settles.', requestId, receiptId);
      }
      if (!messageData) throw createSafeAppError('missing', 'Message not found', requestId, receiptId);
      if (messageData.kind !== 'human' || messageData.authorId !== callerUid) {
        throw createSafeAppError('forbidden', 'Only the author can edit this human message', requestId, receiptId);
      }
      if (messageData.deletedAt) throw createSafeAppError('conflict', 'Cannot edit a deleted message', requestId, receiptId);
      if (!Number.isSafeInteger(messageData.version) || messageData.version < 1 || messageData.version >= Number.MAX_SAFE_INTEGER ||
          messageData.version !== input.expectedVersion) {
        throw createSafeAppError('conflict', 'Message version conflict', requestId, receiptId);
      }
      if (!Number.isSafeInteger(messageData.seq) || messageData.seq < 1 ||
          !Number.isSafeInteger(roomData.nextSeq - 1) || roomData.nextSeq - 1 < messageData.seq) {
        throw createSafeAppError('conflict', 'Conversation range is unavailable', requestId, receiptId);
      }
    } catch (error) {
      if (verdict !== undefined && roomData?.state === 'active') {
        settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, canonicalPayloadHash);
      }
      return { error };
    }
    if (verdict === undefined) {
      transaction.create(submissionRef, {
        id: submissionId, operation: 'editMessage', callerUid, roomId: input.roomId, messageId: input.messageId,
        expectedVersion: input.expectedVersion, payloadHash: canonicalPayloadHash, state: 'pending',
        leaseExpiresAt: Date.now() + SUBMISSION_LEASE_MS, createdAt: FieldValue.serverTimestamp(),
      });
      return { claimed: true as const };
    }
    const nextVersion = messageData!.version + 1;
    const editedSeq = messageData!.seq;
    const highwaterSeq = roomData!.nextSeq - 1;
    const jobId = `${callerUid}_invalidateContext_${requestId}`;
    const jobRef = db.collection('maintenanceJobs').doc(jobId);
    const now = FieldValue.serverTimestamp();

    // Atomic update preserving previous approved text until this transaction commits
    transaction.update(messageRef, {
      text: input.text,
      version: nextVersion,
      editedAt: now,
    });

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
      mutationKind: 'edit',
      editedSeq,
      highwaterSeq,
      cursorSeq: editedSeq + 1,
      operation: 'invalidateContext',
      status: 'pending' as OperationStatus,
      invalidatedCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    transaction.delete(submissionRef);

    transaction.set(receiptRef, {
      operationId: receiptId,
      callerUid,
      operation: 'editMessage',
      requestId,
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
      payloadHash: canonicalPayloadHash,
      status: 'complete' as OperationStatus,
      createdAt: now,
    });

    return { result: {
      operationId: receiptId,
      status: 'complete' as const,
      roomId: input.roomId,
      messageId: input.messageId,
      version: nextVersion,
    } };
  });
  const admission = await transact();
  if ('error' in admission) throw admission.error;
  if (admission.result) return finish(admission.result);
  const screen = await executeScreening(moderation, input.text);
  const settlement = await transact(screen.verdict);
  if ('error' in settlement) throw settlement.error;
  return finish(settlement.result!);
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
