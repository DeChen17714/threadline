import type { Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { createSafeAppError } from '../utils/errors.js';
import { requireAiAccess, getServerAiPolicy } from '../ai/policy.js';

export interface GetOperationInput {
  readonly operationId: string;
}


export async function handleGetOperation(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: GetOperationInput
): Promise<CommandResult> {
  const jobRef = db.collection('maintenanceJobs').doc(input.operationId);
  const jobSnap = await jobRef.get();

  if (jobSnap.exists) {
    const jobData = jobSnap.data()!;
    if (jobData.operation === 'invalidateContext') {
      const roomId = typeof jobData.roomId === 'string' ? jobData.roomId : null;
      if (!roomId) {
        throw createSafeAppError('forbidden', 'Not authorized to view this operation', requestId, input.operationId);
      }
      const roomRef = db.collection('rooms').doc(roomId);
      const roomSnap = await roomRef.get();
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

      const jobStatus: OperationStatus =
        jobData.status === 'pending' || jobData.status === 'failed' || jobData.status === 'cancelled'
          ? jobData.status
          : 'complete';

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

    const jobStatus: OperationStatus =
      jobData.status === 'pending' || jobData.status === 'failed' || jobData.status === 'cancelled'
        ? jobData.status
        : 'complete';

    return {
      operationId: input.operationId,
      status: jobStatus,
      roomId: typeof jobData.roomId === 'string' ? jobData.roomId : undefined,
      ...(typeof jobData.deletedCount === 'number' ? { deletedCount: jobData.deletedCount } : {}),
    };
  }

  const receiptRef = db.collection('receipts').doc(input.operationId);
  const receiptSnap = await receiptRef.get();

  if (!receiptSnap.exists) {
    throw createSafeAppError('missing', 'Operation not found', requestId, input.operationId);
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

  if (receipt.operation === 'deleteRoom') {
    const targetJobId = typeof receipt.operationId === 'string' && receipt.operationId.length > 0
      ? receipt.operationId
      : (receiptRoomId ? `${callerUid}_deleteRoom_${receiptRoomId}` : null);

    if (targetJobId) {
      const linkedJobSnap = await db.collection('maintenanceJobs').doc(targetJobId).get();
      if (linkedJobSnap.exists) {
        const linkedJobData = linkedJobSnap.data()!;
        if (linkedJobData.callerUid !== callerUid || linkedJobData.operation !== 'deleteRoom' || linkedJobData.roomId !== receiptRoomId) {
          throw createSafeAppError('forbidden', 'Not authorized to view this operation', requestId);
        }
        const linkedStatus: OperationStatus =
          linkedJobData.status === 'pending' || linkedJobData.status === 'failed' || linkedJobData.status === 'cancelled'
            ? linkedJobData.status
            : 'complete';
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
    const roomSnap = await roomRef.get();

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
  const status: OperationStatus =
    receipt.status === 'pending' || receipt.status === 'failed' || receipt.status === 'cancelled'
      ? receipt.status
      : 'complete';

  return {
    operationId,
    status,
    roomId: receiptRoomId ?? undefined,
    ...(typeof receipt.messageId === 'string' ? { messageId: receipt.messageId } : {}),
    ...(typeof receipt.seq === 'number' ? { seq: receipt.seq } : {}),
    ...(typeof receipt.version === 'number' ? { version: receipt.version } : {}),
    ...(receipt.operation === 'issueInvite' ? { tokenUnavailable: true } : {}),
  };
}
