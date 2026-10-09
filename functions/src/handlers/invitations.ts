import { randomBytes, createHash } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';

export interface IssueInviteInput {
  readonly roomId: string;
}

export interface RevokeInviteInput {
  readonly roomId: string;
}

export interface PreviewInviteInput {
  readonly token: string;
}

export interface JoinRoomInput {
  readonly token: string;
}

function parseOperationStatus(status: unknown): OperationStatus {
  if (status === 'pending' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  return 'complete';
}

function parseExpirationMillis(expiresAt: unknown): number | null {
  return expiresAt instanceof Timestamp ? expiresAt.toMillis() : null;
}

export async function handleIssueInvite(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: IssueInviteInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_issueInvite_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
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

      // Reauthorize current creator on active room
      const roomRef = db.collection('rooms').doc(input.roomId);
      const roomSnap = await transaction.get(roomRef);
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
      if (roomData.creatorId !== callerUid) {
        throw createSafeAppError('forbidden', 'Only the room creator can issue invitations', requestId, receiptId);
      }

      const operationId = typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId;
      const status = parseOperationStatus(receiptData.status);

      // Replay returns tokenUnavailable without exposing or regenerating token
      return {
        operationId,
        status,
        roomId: input.roomId,
        tokenUnavailable: true,
      };
    }

    const roomRef = db.collection('rooms').doc(input.roomId);
    const roomSnap = await transaction.get(roomRef);
    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room not found', requestId, receiptId);
    }

    const roomData = roomSnap.data()!;
    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
    }
    if (roomData.creatorId !== callerUid) {
      throw createSafeAppError('forbidden', 'Only the room creator can issue invitations', requestId, receiptId);
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const currentVersion = typeof roomData.invitationVersion === 'number' ? roomData.invitationVersion : 0;
    const nextVersion = currentVersion + 1;

    const expiresAtMillis = Date.now() + 24 * 60 * 60 * 1000;
    const expiresAtTimestamp = Timestamp.fromMillis(expiresAtMillis);

    const inviteRef = db.collection('invites').doc(tokenHash);
    const inviteDoc = {
      roomId: input.roomId,
      creatorId: callerUid,
      version: nextVersion,
      expiresAt: expiresAtTimestamp,
      revoked: false,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    transaction.set(inviteRef, inviteDoc);
    transaction.update(roomRef, {
      invitationVersion: nextVersion,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const receiptDoc = {
      operationId: receiptId,
      callerUid,
      operation: 'issueInvite',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'complete',
      roomId: input.roomId,
      tokenUnavailable: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: receiptId,
      status: 'complete',
      roomId: input.roomId,
      token: rawToken,
      expiresAt: expiresAtMillis,
    };
  });
}

export async function handleRevokeInvite(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: RevokeInviteInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_revokeInvite_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
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

      const roomRef = db.collection('rooms').doc(input.roomId);
      const roomSnap = await transaction.get(roomRef);
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
      if (roomData.creatorId !== callerUid) {
        throw createSafeAppError('forbidden', 'Only the room creator can revoke invitations', requestId, receiptId);
      }

      const operationId = typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId;
      const status = parseOperationStatus(receiptData.status);

      return {
        operationId,
        status,
        roomId: input.roomId,
      };
    }

    const roomRef = db.collection('rooms').doc(input.roomId);
    const roomSnap = await transaction.get(roomRef);
    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room not found', requestId, receiptId);
    }

    const roomData = roomSnap.data()!;
    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (roomData.state !== 'active' || !memberIds.includes(callerUid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
    }
    if (roomData.creatorId !== callerUid) {
      throw createSafeAppError('forbidden', 'Only the room creator can revoke invitations', requestId, receiptId);
    }

    const currentVersion = typeof roomData.invitationVersion === 'number' ? roomData.invitationVersion : 0;
    const nextVersion = currentVersion + 1;


    transaction.update(roomRef, {
      invitationVersion: nextVersion,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const receiptDoc = {
      operationId: receiptId,
      callerUid,
      operation: 'revokeInvite',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'complete',
      roomId: input.roomId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: receiptId,
      status: 'complete',
      roomId: input.roomId,
    };
  });
}

export async function handlePreviewInvite(
  db: Firestore,
  _callerUid: string,
  requestId: string,
  input: PreviewInviteInput
): Promise<CommandResult> {
  const tokenHash = createHash('sha256').update(input.token).digest('hex');

  const inviteRef = db.collection('invites').doc(tokenHash);
  const inviteSnap = await inviteRef.get();

  if (!inviteSnap.exists) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const inviteData = inviteSnap.data()!;
  if (inviteData.revoked === true) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const expiresAtMillis = parseExpirationMillis(inviteData.expiresAt);
  if (expiresAtMillis === null || Date.now() >= expiresAtMillis) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const roomId = typeof inviteData.roomId === 'string' ? inviteData.roomId : null;
  if (!roomId) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const roomSnap = await roomRef.get();

  if (!roomSnap.exists) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const roomData = roomSnap.data()!;
  if (roomData.state !== 'active') {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  if (roomData.invitationVersion !== inviteData.version) {
    throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
  }

  const rawMemberIds = roomData.memberIds;
  const memberIds = Array.isArray(rawMemberIds)
    ? rawMemberIds.filter((id): id is string => typeof id === 'string')
    : [];

  const name = typeof roomData.name === 'string' ? roomData.name : '';
  const description = typeof roomData.description === 'string' ? roomData.description : '';

  return {
    operationId: `preview_${requestId}`,
    status: 'complete',
    roomId,
    room: {
      id: roomId,
      name,
      description,
      memberCount: memberIds.length,
    },
    expiresAt: expiresAtMillis,
  };
}

export async function handleJoinRoom(
  db: Firestore,
  callerUid: string,
  callerLabel: string,
  requestId: string,
  input: JoinRoomInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_joinRoom_${requestId}`;
  const tokenHash = createHash('sha256').update(input.token).digest('hex');
  const canonicalPayloadHash = computePayloadHash({
    tokenHash,
  });

  return await db.runTransaction(async (transaction) => {
    const receiptRef = db.collection('receipts').doc(receiptId);
    const receiptSnap = await transaction.get(receiptRef);

    // 1. Validate invitation and room state in this transaction
    const inviteRef = db.collection('invites').doc(tokenHash);
    const inviteSnap = await transaction.get(inviteRef);

    if (!inviteSnap.exists) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const inviteData = inviteSnap.data()!;
    if (inviteData.revoked === true) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const expiresAtMillis = parseExpirationMillis(inviteData.expiresAt);
    if (expiresAtMillis === null || Date.now() >= expiresAtMillis) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const roomId = typeof inviteData.roomId === 'string' ? inviteData.roomId : null;
    if (!roomId) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
    }

    const roomData = roomSnap.data()!;
    if (roomData.state !== 'active') {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
    }

    // Version fence: ensure invite is still current version
    if (roomData.invitationVersion !== inviteData.version) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId);
    }

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

      // Replay must verify current active member status
      const rawMemberIds = roomData.memberIds;
      const memberIds = Array.isArray(rawMemberIds)
        ? rawMemberIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (!memberIds.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not a member of this room', requestId, receiptId);
      }

      const operationId = typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId;
      const status = parseOperationStatus(receiptData.status);

      return {
        operationId,
        status,
        roomId,
      };
    }

    // New join attempt
    const rawMemberIds = roomData.memberIds;
    const existingMemberIds: string[] = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];

    const rawMembers = roomData.members;
    const existingMembers: Array<{ uid: string; label: string }> = Array.isArray(rawMembers)
      ? rawMembers.filter((m): m is { uid: string; label: string } => {
          return Boolean(m && typeof m === 'object' && 'uid' in m && typeof m.uid === 'string' && 'label' in m && typeof m.label === 'string');
        })
      : [];

    const alreadyMember = existingMemberIds.includes(callerUid);

    if (!alreadyMember) {
      if (existingMemberIds.length >= 20) {
        throw createSafeAppError('room-busy', 'Room is at maximum capacity (20 members)', requestId, receiptId);
      }

      existingMemberIds.push(callerUid);
      existingMembers.push({
        uid: callerUid,
        label: callerLabel,
      });

      transaction.update(roomRef, {
        memberIds: existingMemberIds,
        members: existingMembers,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const receiptDoc = {
      operationId: receiptId,
      callerUid,
      operation: 'joinRoom',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'complete',
      roomId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: receiptId,
      status: 'complete',
      roomId,
    };
  });
}
