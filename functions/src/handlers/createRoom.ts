import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';

export interface CreateRoomInput {
  readonly name: string;
  readonly description: string;
}

export async function handleCreateRoom(
  db: Firestore,
  callerUid: string,
  callerLabel: string,
  requestId: string,
  input: CreateRoomInput
): Promise<CommandResult> {
  const trimmedName = input.name.trim();
  const trimmedDescription = input.description.trim();

  if (trimmedName.length < 1 || trimmedName.length > 80) {
    throw createSafeAppError('validation', 'Room name must be between 1 and 80 characters', requestId);
  }
  if (trimmedDescription.length > 500) {
    throw createSafeAppError('validation', 'Description must not exceed 500 characters', requestId);
  }

  const receiptId = `${callerUid}_createRoom_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    name: input.name,
    description: input.description,
  });

  return await db.runTransaction(async (transaction) => {
    const receiptRef = db.collection('receipts').doc(receiptId);
    const receiptSnap = await transaction.get(receiptRef);

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

      const existingRoomId = receiptData.roomId as string | undefined;
      if (!existingRoomId) {
        return {
          operationId: (receiptData.operationId as string) || receiptId,
          status: (receiptData.status as OperationStatus) || 'complete',
        };
      }

      const roomRef = db.collection('rooms').doc(existingRoomId);
      const roomSnap = await transaction.get(roomRef);

      if (!roomSnap.exists) {
        throw createSafeAppError('forbidden', 'Room no longer exists', requestId, receiptId);
      }

      const roomData = roomSnap.data()!;
      const memberIds = Array.isArray(roomData.memberIds) ? roomData.memberIds : [];
      if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
      }

      return {
        operationId: (receiptData.operationId as string) || receiptId,
        status: (receiptData.status as OperationStatus) || 'complete',
        roomId: existingRoomId,
      };
    }

    const roomId = randomUUID();
    const roomRef = db.collection('rooms').doc(roomId);
    const now = FieldValue.serverTimestamp();

    const roomDoc = {
      id: roomId,
      name: trimmedName,
      description: trimmedDescription,
      creatorId: callerUid,
      memberIds: [callerUid],
      members: [
        {
          uid: callerUid,
          label: callerLabel,
        },
      ],
      state: 'active',
      nextSeq: 1,
      activeGenerationId: null,
      latestAiPromptId: null,
      maintenanceId: null,
      maintenanceState: null,
      invitationVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    const receiptDoc = {
      operationId: receiptId,
      callerUid,
      operation: 'createRoom',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'complete',
      roomId,
      createdAt: now,
      updatedAt: now,
    };

    transaction.set(roomRef, roomDoc);
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: receiptId,
      status: 'complete',
      roomId,
    };
  });
}
