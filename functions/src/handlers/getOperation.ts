import { type Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { createSafeAppError } from '../utils/errors.js';
import { requireAiAccess, getServerAiPolicy } from '../ai/policy.js';
import { isLiveSubmission, settleSubmissionFailure, submissionReceiptResult } from '../moderation/submissions.js';

export interface GetOperationInput {
  readonly operationId: string;
}

function operationStatus(value: unknown, requestId: string): OperationStatus {
  if (value === 'pending' || value === 'failed' || value === 'cancelled' || value === 'complete') return value;
  throw createSafeAppError('conflict', 'Operation state is unavailable', requestId);
}

export async function handleGetOperation(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: GetOperationInput
): Promise<CommandResult> {
  return db.runTransaction(async (transaction) => {
  const jobRef = db.collection('maintenanceJobs').doc(input.operationId);
  const jobSnap = await transaction.get(jobRef);

  if (jobSnap.exists) {
    const jobData = jobSnap.data()!;
    if (jobData.operation === 'invalidateContext') {
      const roomId = typeof jobData.roomId === 'string' ? jobData.roomId : null;
      if (!roomId) {
        throw createSafeAppError('forbidden', 'Not authorized to view this operation', requestId, input.operationId);
      }
      const roomRef = db.collection('rooms').doc(roomId);
      const roomSnap = await transaction.get(roomRef);
      if (!roomSnap.exists) {
        throw createSafeAppError('forbidden', 'Room no longer exists', requestId, input.operationId);
      }
      const roomData = roomSnap.data()!;
      const rawMemberIds = roomData.memberIds;
      const memberIds = Array.isArray(rawMemberIds)
        ? rawMemberIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, input.operationId);
      }

      const jobStatus = operationStatus(jobData.status, requestId);

      return {
        operationId: input.operationId,
        status: jobStatus,
        roomId,
      };
    }

    if (jobData.callerUid !== callerUid) {
      throw createSafeAppError(
        'forbidden',
        'Not authorized to view this operation',
        requestId,
        input.operationId
      );
    }

    const jobStatus = operationStatus(jobData.status, requestId);

    return {
      operationId: input.operationId,
      status: jobStatus,
      roomId: typeof jobData.roomId === 'string' ? jobData.roomId : undefined,
      ...(typeof jobData.deletedCount === 'number' ? { deletedCount: jobData.deletedCount } : {}),
    };
  }

  const receiptRef = db.collection('receipts').doc(input.operationId);
  const submissionRef = db.collection('submissions').doc(input.operationId);
  const [receiptSnap, submissionSnap] = await Promise.all([
    transaction.get(receiptRef), transaction.get(submissionRef),
  ]);

  if (!receiptSnap.exists) {
    const submission = submissionSnap.data();
    if (!submission) throw createSafeAppError('missing', 'Operation not found', requestId, input.operationId);
    if (submission.callerUid !== callerUid) {
      throw createSafeAppError('forbidden', 'Not authorized to view this operation', requestId, input.operationId);
    }
    if (submission.operation === 'askThreadline' || submission.operation === 'retryAiReply') {
      requireAiAccess(callerUid, requestId, getServerAiPolicy());
    } else if (submission.operation !== 'sendRoomMessage' && submission.operation !== 'editMessage') {
      throw createSafeAppError('conflict', 'Operation state is unavailable', requestId, input.operationId);
    }
    if (typeof submission.roomId !== 'string' || !submission.roomId ||
        typeof submission.payloadHash !== 'string' || !submission.payloadHash || submission.state !== 'pending') {
      throw createSafeAppError('conflict', 'Operation state is unavailable', requestId, input.operationId);
    }
    const roomSnap = await transaction.get(db.collection('rooms').doc(submission.roomId));
    const room = roomSnap.data();
    if (!room || room.state !== 'active' || !Array.isArray(room.memberIds) || !room.memberIds.includes(callerUid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, input.operationId);
    }
    if (!isLiveSubmission(submission, callerUid, submission.payloadHash)) {
      return settleSubmissionFailure(transaction, submissionSnap, receiptSnap, callerUid, submission.payloadHash);
    }
    return {
      operationId: input.operationId,
      status: 'pending',
      roomId: submission.roomId,
      ...(typeof submission.messageId === 'string' ? { messageId: submission.messageId } : {}),
    };
  }

  const receipt = receiptSnap.data()!;

  if (receipt.callerUid !== callerUid) {
    throw createSafeAppError(
      'forbidden',
      'Not authorized to view this operation',
      requestId,
      input.operationId
    );
  }
  if (receipt.operation === 'askThreadline' || receipt.operation === 'retryAiReply') {
    requireAiAccess(callerUid, requestId, getServerAiPolicy());
  }

  const receiptRoomId = typeof receipt.roomId === 'string' && receipt.roomId.length > 0
    ? receipt.roomId
    : null;
  if ((receipt.operation === 'sendRoomMessage' || receipt.operation === 'editMessage' ||
      receipt.operation === 'askThreadline' || receipt.operation === 'retryAiReply') && !receiptRoomId) {
    throw createSafeAppError('conflict', 'Operation state is unavailable', requestId, input.operationId);
  }

  if (receipt.operation === 'deleteRoom') {
    const targetJobId = typeof receipt.operationId === 'string' && receipt.operationId.length > 0
      ? receipt.operationId
      : (receiptRoomId ? `${callerUid}_deleteRoom_${receiptRoomId}` : null);

    if (targetJobId) {
      const linkedJobSnap = await transaction.get(db.collection('maintenanceJobs').doc(targetJobId));
      if (linkedJobSnap.exists) {
        const linkedJobData = linkedJobSnap.data()!;
        if (linkedJobData.callerUid !== callerUid || linkedJobData.operation !== 'deleteRoom' || linkedJobData.roomId !== receiptRoomId) {
          throw createSafeAppError('forbidden', 'Not authorized to view this operation', requestId);
        }
        const linkedStatus = operationStatus(linkedJobData.status, requestId);
        return {
          operationId: targetJobId,
          status: linkedStatus,
          roomId: typeof linkedJobData.roomId === 'string' ? linkedJobData.roomId : (receiptRoomId ?? undefined),
          ...(typeof linkedJobData.deletedCount === 'number' ? { deletedCount: linkedJobData.deletedCount } : {}),
        };
      }
    }

    throw createSafeAppError('missing', 'Deletion job is unavailable; cleanup is not confirmed', requestId);
  }
  if (receiptRoomId) {
    const roomRef = db.collection('rooms').doc(receiptRoomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room no longer exists', requestId, input.operationId);
    }

    const roomData = roomSnap.data()!;
    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
      throw createSafeAppError(
        'forbidden',
        'Not an active member of this room',
        requestId,
        input.operationId
      );
    }

    if (receipt.operation === 'issueInvite' || receipt.operation === 'revokeInvite') {
      if (roomData.creatorId !== callerUid) {
        throw createSafeAppError(
          'forbidden',
          'Only the room creator can access this operation',
          requestId,
          input.operationId
        );
      }
    }
  }

  const operationId = typeof receipt.operationId === 'string' ? receipt.operationId : input.operationId;
  const status = operationStatus(receipt.status, requestId);

  return {
    operationId,
    status,
    roomId: receiptRoomId ?? undefined,
    ...(typeof receipt.messageId === 'string' ? { messageId: receipt.messageId } : {}),
    ...(typeof receipt.seq === 'number' ? { seq: receipt.seq } : {}),
    ...(typeof receipt.version === 'number' ? { version: receipt.version } : {}),
    ...(status === 'failed' && (receipt.operation === 'sendRoomMessage' || receipt.operation === 'editMessage' ||
      receipt.operation === 'askThreadline' || receipt.operation === 'retryAiReply')
      ? { errorCode: submissionReceiptResult(receipt, operationId).errorCode } : {}),
    ...(receipt.operation === 'issueInvite' ? { tokenUnavailable: true } : {}),
  };
  });
}
