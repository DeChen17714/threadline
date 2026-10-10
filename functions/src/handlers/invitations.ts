import { randomBytes, createHash } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { CommandResult, OperationStatus, JoinStatus, JoinRequestSummary } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';

export interface IssueInviteInput {
  readonly roomId: string;
}

export interface RevokeInviteInput {
  readonly roomId: string;
}

export interface RequestJoinInput {
  readonly token: string;
}

export interface GetJoinStatusInput {
  readonly joinRequestId: string;
}

export interface ListJoinRequestsInput {
  readonly roomId: string;
}

export interface DecideJoinInput {
  readonly roomId: string;
  readonly joinRequestId: string;
  readonly decision: 'approve' | 'reject';
}

function parseOperationStatus(status: unknown): OperationStatus {
  if (status === 'pending' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  return 'complete';
}

function parseExpirationMillis(expiresAt: unknown): number | null {
  if (expiresAt instanceof Timestamp) {
    const millis = expiresAt.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

interface ProjectedAdmission {
  readonly effectiveStatus: JoinStatus;
  readonly isCurrentMember: boolean;
  readonly shouldMarkExpired: boolean;
}

function projectJoinStatus(
  joinData: FirebaseFirestore.DocumentData,
  roomSnap: FirebaseFirestore.DocumentSnapshot | null,
  inviteSnap: FirebaseFirestore.DocumentSnapshot | null,
  now: number,
  applicantUid: string
): ProjectedAdmission {
  if (joinData.status === 'rejected') {
    return {
      effectiveStatus: 'rejected',
      isCurrentMember: false,
      shouldMarkExpired: false,
    };
  }

  if (joinData.status === 'approved') {
    let isCurrentMember = false;
    if (roomSnap && roomSnap.exists) {
      const roomData = roomSnap.data()!;
      const isRoomActive = roomData.state === 'active';
      const rawMemberIds = roomData.memberIds;
      const memberIds = Array.isArray(rawMemberIds)
        ? rawMemberIds.filter((id): id is string => typeof id === 'string')
        : [];
      isCurrentMember = isRoomActive && memberIds.includes(applicantUid);
    }
    return {
      effectiveStatus: 'approved',
      isCurrentMember,
      shouldMarkExpired: false,
    };
  }

  if (joinData.status === 'expired') {
    return {
      effectiveStatus: 'expired',
      isCurrentMember: false,
      shouldMarkExpired: false,
    };
  }

  if (joinData.status !== 'pending') {
    return { effectiveStatus: 'expired', isCurrentMember: false, shouldMarkExpired: false };
  }
  const reqExpiresMillis = parseExpirationMillis(joinData.expiresAt);
  if (reqExpiresMillis === null || !Number.isFinite(reqExpiresMillis) || now >= reqExpiresMillis) {
    return {
      effectiveStatus: 'expired',
      isCurrentMember: false,
      shouldMarkExpired: true,
    };
  }

  if (!roomSnap || !roomSnap.exists) {
    return {
      effectiveStatus: 'expired',
      isCurrentMember: false,
      shouldMarkExpired: true,
    };
  }

  const roomData = roomSnap.data()!;
  if (roomData.state !== 'active') {
    return {
      effectiveStatus: 'expired',
      isCurrentMember: false,
      shouldMarkExpired: true,
    };
  }

  if (roomData.invitationVersion !== joinData.inviteVersion) {
    return {
      effectiveStatus: 'expired',
      isCurrentMember: false,
      shouldMarkExpired: true,
    };
  }

  if (!inviteSnap) {
    return { effectiveStatus: 'expired', isCurrentMember: false, shouldMarkExpired: true };
  }
  if (inviteSnap) {
    if (!inviteSnap.exists) {
      return {
        effectiveStatus: 'expired',
        isCurrentMember: false,
        shouldMarkExpired: true,
      };
    }
    const inviteData = inviteSnap.data()!;
    if (inviteData.revoked === true || inviteData.status !== 'active') {
      return {
        effectiveStatus: 'expired',
        isCurrentMember: false,
        shouldMarkExpired: true,
      };
    }
    if (inviteData.version !== roomData.invitationVersion) {
      return {
        effectiveStatus: 'expired',
        isCurrentMember: false,
        shouldMarkExpired: true,
      };
    }
    const inviteExpiresMillis = parseExpirationMillis(inviteData.expiresAt);
    if (inviteExpiresMillis === null || !Number.isFinite(inviteExpiresMillis) || now >= inviteExpiresMillis) {
      return {
        effectiveStatus: 'expired',
        isCurrentMember: false,
        shouldMarkExpired: true,
      };
    }
  }

  return {
    effectiveStatus: 'pending',
    isCurrentMember: false,
    shouldMarkExpired: false,
  };
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

export async function handleRequestJoin(
  db: Firestore,
  callerUid: string,
  callerLabel: string,
  requestId: string,
  input: RequestJoinInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_requestJoin_${requestId}`;
  const tokenHash = createHash('sha256').update(input.token).digest('hex');
  const canonicalPayloadHash = computePayloadHash({
    tokenHash,
  });

  return await db.runTransaction(async (transaction) => {
    // 1. Receipt check (Original same UUID replay: NEVER consumes another attempt)
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

      const operationId = typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId;
      const status = parseOperationStatus(receiptData.status);
      const joinRequestId = typeof receiptData.joinRequestId === 'string' ? receiptData.joinRequestId : requestId;

      // Reauthorize applicant on joinRequest
      const joinRequestRef = db.collection('joinRequests').doc(joinRequestId);
      const joinRequestSnap = await transaction.get(joinRequestRef);
      if (!joinRequestSnap.exists) {
        throw createSafeAppError('forbidden', 'Join request no longer exists', requestId, receiptId);
      }
      const joinData = joinRequestSnap.data()!;
      if (joinData.applicantUid !== callerUid) {
        throw createSafeAppError('forbidden', 'Not authorized to view this join request', requestId, receiptId);
      }

      const roomId = typeof joinData.roomId === 'string' ? joinData.roomId : (typeof receiptData.roomId === 'string' ? receiptData.roomId : null);
      const roomSnap = roomId ? await transaction.get(db.collection('rooms').doc(roomId)) : null;
      const effectiveTokenHash = typeof joinData.tokenHash === 'string' ? joinData.tokenHash : tokenHash;
      const inviteSnap = effectiveTokenHash ? await transaction.get(db.collection('invites').doc(effectiveTokenHash)) : null;

      const now = Date.now();
      const { effectiveStatus, isCurrentMember, shouldMarkExpired } = projectJoinStatus(
        joinData,
        roomSnap,
        inviteSnap,
        now,
        callerUid
      );

      if (shouldMarkExpired && joinData.status === 'pending') {
        transaction.update(joinRequestRef, {
          status: 'expired',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      const includeRoomId = effectiveStatus === 'approved' && isCurrentMember && roomId !== null;

      return {
        operationId,
        status,
        joinRequestId,
        joinStatus: effectiveStatus,
        ...(includeRoomId ? { roomId } : {}),
      };
    }

    // 2. Validate UUID target collision before writes (Defect 1)
    const targetRequestRef = db.collection('joinRequests').doc(requestId);
    const targetRequestSnap = await transaction.get(targetRequestRef);
    if (targetRequestSnap.exists) {
      throw createSafeAppError('conflict', 'Request ID already used', requestId, receiptId);
    }

    // 3. Validate Token, Invite, and Room
    const now = Date.now();
    const inviteRef = db.collection('invites').doc(tokenHash);
    const inviteSnap = await transaction.get(inviteRef);

    if (!inviteSnap.exists) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const inviteData = inviteSnap.data()!;
    if (inviteData.revoked === true || inviteData.status !== 'active') {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const expiresAtMillis = parseExpirationMillis(inviteData.expiresAt);
    if (expiresAtMillis === null || !Number.isFinite(expiresAtMillis) || now >= expiresAtMillis) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const roomId = typeof inviteData.roomId === 'string' ? inviteData.roomId : null;
    if (!roomId) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const roomData = roomSnap.data()!;
    if (roomData.state !== 'active') {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    if (roomData.invitationVersion !== inviteData.version) {
      throw createSafeAppError('forbidden', 'Invitation is invalid or has expired', requestId, receiptId);
    }

    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (memberIds.includes(callerUid)) {
      throw createSafeAppError('conflict', 'Already an active member of this room', requestId, receiptId);
    }

    if (memberIds.length >= 20) {
      throw createSafeAppError('room-busy', 'Room is at maximum capacity (20 members)', requestId, receiptId);
    }

    // 4. Rate Limiting: 3 sliding attempts / UID / 10 minutes
    // Distinct new UUIDs are distinct admission attempts even when deduped: check quota FIRST
    const quotaRef = db.collection('quotaBuckets').doc(`requestJoin_${callerUid}`);
    const quotaSnap = await transaction.get(quotaRef);
    const rawAttempts = quotaSnap.exists && Array.isArray(quotaSnap.data()?.attempts)
      ? quotaSnap.data()!.attempts
      : [];
    const validAttempts = rawAttempts.filter(
      (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t) && now - t < 10 * 60 * 1000
    );

    if (validAttempts.length >= 3) {
      const oldest = Math.min(...validAttempts);
      const retryAt = oldest + 10 * 60 * 1000;
      throw createSafeAppError(
        'throttled',
        'Join request rate limit exceeded. Maximum 3 attempts per 10 minutes.',
        requestId,
        receiptId,
        retryAt
      );
    }

    // 5. Private Queue Bookkeeping & Concurrency Fence (joinQueues doc per room)
    const queueRef = db.collection('joinQueues').doc(roomId);
    const queueSnap = await transaction.get(queueRef);

    let candidateIds: string[] = [];
    if (queueSnap.exists) {
      const qData = queueSnap.data()!;
      if (Array.isArray(qData.requestIds)) {
        candidateIds = qData.requestIds.filter((id): id is string => typeof id === 'string');
      }
    }


    const requestSnaps = await Promise.all(
      candidateIds.slice(0, 20).map((id) => transaction.get(db.collection('joinRequests').doc(id)))
    );

    let duplicateActiveRequest: { joinRequestId: string } | null = null;
    const liveQueuedIds: string[] = [];
    const expiredDocs: FirebaseFirestore.DocumentReference[] = [];

    for (const snap of requestSnaps) {
      if (!snap.exists) continue;
      const data = snap.data()!;
      if (data.roomId !== roomId) continue;

      const { effectiveStatus, shouldMarkExpired } = projectJoinStatus(
        data,
        roomSnap,
        inviteSnap,
        now,
        data.applicantUid
      );

      if (effectiveStatus !== 'pending') {
        if (shouldMarkExpired && data.status === 'pending') {
          expiredDocs.push(snap.ref);
        }
      } else {
        liveQueuedIds.push(snap.id);
        if (data.applicantUid === callerUid && data.inviteVersion === roomData.invitationVersion) {
          duplicateActiveRequest = { joinRequestId: typeof data.joinRequestId === 'string' ? data.joinRequestId : snap.id };
        }
      }
    }

    // Reconcile expired slots in place
    for (const ref of expiredDocs) {
      transaction.update(ref, {
        status: 'expired',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // 6. Duplicate Active Request Handling
    if (duplicateActiveRequest !== null) {
      // Dedup distinct ID receipt aliases count once against quota
      validAttempts.push(now);
      transaction.set(quotaRef, {
        attempts: validAttempts.slice(-3),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Update queue to retain only reconciled live requests
      transaction.set(queueRef, {
        roomId,
        requestIds: liveQueuedIds,
        updatedAt: FieldValue.serverTimestamp(),
      });

      const receiptDoc = {
        operationId: receiptId,
        callerUid,
        operation: 'requestJoin',
        requestId,
        payloadHash: canonicalPayloadHash,
        status: 'complete',
        joinRequestId: duplicateActiveRequest.joinRequestId,
        joinStatus: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(receiptRef, receiptDoc);

      return {
        operationId: receiptId,
        status: 'complete',
        joinRequestId: duplicateActiveRequest.joinRequestId,
        joinStatus: 'pending',
      };
    }

    // 7. Enforce 20 pending queue limit
    if (liveQueuedIds.length >= 20) {
      throw createSafeAppError(
        'room-busy',
        'Join request queue is full (maximum 20 pending requests)',
        requestId,
        receiptId
      );
    }

    // 8. Commit fresh join request, private queue, quota, and receipt
    const joinRequestDoc = {
      joinRequestId: requestId,
      roomId,
      applicantUid: callerUid,
      applicantLabel: callerLabel,
      tokenHash,
      inviteVersion: roomData.invitationVersion,
      status: 'pending',
      expiresAt: inviteData.expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(targetRequestRef, joinRequestDoc);

    const updatedQueuedIds = [...liveQueuedIds, requestId];
    transaction.set(queueRef, {
      roomId,
      requestIds: updatedQueuedIds,
      updatedAt: FieldValue.serverTimestamp(),
    });

    validAttempts.push(now);
    transaction.set(quotaRef, {
      attempts: validAttempts.slice(-3),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const receiptDoc = {
      operationId: receiptId,
      callerUid,
      operation: 'requestJoin',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'complete',
      joinRequestId: requestId,
      joinStatus: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: receiptId,
      status: 'complete',
      joinRequestId: requestId,
      joinStatus: 'pending',
    };
  });
}

export async function handleGetJoinStatus(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: GetJoinStatusInput
): Promise<CommandResult> {
  return await db.runTransaction(async (transaction) => {
    const joinRequestRef = db.collection('joinRequests').doc(input.joinRequestId);
    const joinRequestSnap = await transaction.get(joinRequestRef);

    if (!joinRequestSnap.exists) {
      throw createSafeAppError('missing', 'Join request not found', requestId);
    }

    const joinData = joinRequestSnap.data()!;
    if (joinData.applicantUid !== callerUid) {
      throw createSafeAppError('forbidden', 'Not authorized to view this join request', requestId);
    }

    const roomId = typeof joinData.roomId === 'string' ? joinData.roomId : null;
    const roomSnap = roomId ? await transaction.get(db.collection('rooms').doc(roomId)) : null;

    const tokenHash = typeof joinData.tokenHash === 'string' ? joinData.tokenHash : null;
    const inviteSnap = tokenHash ? await transaction.get(db.collection('invites').doc(tokenHash)) : null;

    const now = Date.now();
    const { effectiveStatus, isCurrentMember, shouldMarkExpired } = projectJoinStatus(
      joinData,
      roomSnap,
      inviteSnap,
      now,
      callerUid
    );

    if (shouldMarkExpired && joinData.status === 'pending') {
      transaction.update(joinRequestRef, {
        status: 'expired',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const includeRoomId = effectiveStatus === 'approved' && isCurrentMember && roomId !== null;

    return {
      operationId: requestId,
      status: 'complete',
      joinRequestId: input.joinRequestId,
      joinStatus: effectiveStatus,
      ...(includeRoomId ? { roomId } : {}),
    };
  });
}

export async function handleListJoinRequests(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: ListJoinRequestsInput
): Promise<CommandResult> {
  return await db.runTransaction(async (transaction) => {
    const roomRef = db.collection('rooms').doc(input.roomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room not found', requestId);
    }

    const roomData = roomSnap.data()!;
    if (roomData.state !== 'active') {
      throw createSafeAppError('forbidden', 'Room is not active', requestId);
    }

    if (roomData.creatorId !== callerUid) {
      throw createSafeAppError('forbidden', 'Only the room creator can list join requests', requestId);
    }

    const now = Date.now();
    const pendingQuery = db
      .collection('joinRequests')
      .where('roomId', '==', input.roomId)
      .where('status', '==', 'pending')
      .limit(20);
    const pendingSnap = await transaction.get(pendingQuery);

    const joinRequests: JoinRequestSummary[] = [];

    for (const doc of pendingSnap.docs) {
      const data = doc.data();
      const expiresAtMillis = parseExpirationMillis(data.expiresAt);
      const isExpired = expiresAtMillis === null || !Number.isFinite(expiresAtMillis) || now >= expiresAtMillis || data.inviteVersion !== roomData.invitationVersion;

      if (isExpired) {
        transaction.update(doc.ref, {
          status: 'expired',
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const applicantUid = typeof data.applicantUid === 'string' ? data.applicantUid : '';
        const applicantLabel = typeof data.applicantLabel === 'string' ? data.applicantLabel : '';
        const joinRequestId = typeof data.joinRequestId === 'string' ? data.joinRequestId : doc.id;
        joinRequests.push({
          joinRequestId,
          applicantUid,
          applicantLabel,
          expiresAt: expiresAtMillis,
        });
      }
    }

    return {
      operationId: requestId,
      status: 'complete',
      roomId: input.roomId,
      joinRequests,
    };
  });
}

export async function handleDecideJoin(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: DecideJoinInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_decideJoin_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
    joinRequestId: input.joinRequestId,
    decision: input.decision,
  });

  return await db.runTransaction(async (transaction) => {
    // 1. Receipt check & Replay Authorization (Defect 3)
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

      // Reauthorize current creator on active room before ANY decision replay
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
        throw createSafeAppError('forbidden', 'Only the room creator can decide join requests', requestId, receiptId);
      }

      const joinRequestRef = db.collection('joinRequests').doc(input.joinRequestId);
      const joinRequestSnap = await transaction.get(joinRequestRef);
      if (!joinRequestSnap.exists) {
        throw createSafeAppError('missing', 'Join request not found', requestId, receiptId);
      }
      const requestData = joinRequestSnap.data()!;
      if (requestData.roomId !== input.roomId) {
        throw createSafeAppError('forbidden', 'Join request does not belong to this room', requestId, receiptId);
      }

      const operationId = typeof receiptData.operationId === 'string' ? receiptData.operationId : receiptId;
      const status = parseOperationStatus(receiptData.status);
      const joinStatus: JoinStatus = requestData.status;
      if (!['approved', 'rejected', 'expired'].includes(joinStatus)) {
        throw createSafeAppError('conflict', 'Decision is not confirmed', requestId, receiptId);
      }

      return {
        operationId,
        status,
        roomId: input.roomId,
        joinRequestId: input.joinRequestId,
        joinStatus,
      };
    }

    // 2. Reauthorize owner membership & active room for fresh decision
    const roomRef = db.collection('rooms').doc(input.roomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('forbidden', 'Room not found', requestId, receiptId);
    }

    const roomData = roomSnap.data()!;
    if (roomData.state !== 'active') {
      throw createSafeAppError('forbidden', 'Room is not active', requestId, receiptId);
    }

    if (roomData.creatorId !== callerUid) {
      throw createSafeAppError('forbidden', 'Only the room creator can decide join requests', requestId, receiptId);
    }

    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (!memberIds.includes(callerUid)) {
      throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, receiptId);
    }

    // 3. Read join request & validate
    const joinRequestRef = db.collection('joinRequests').doc(input.joinRequestId);
    const joinRequestSnap = await transaction.get(joinRequestRef);

    if (!joinRequestSnap.exists) {
      throw createSafeAppError('missing', 'Join request not found', requestId, receiptId);
    }

    const requestData = joinRequestSnap.data()!;
    if (requestData.roomId !== input.roomId) {
      throw createSafeAppError('forbidden', 'Join request does not belong to this room', requestId, receiptId);
    }

    // 4. Read invite doc & atomically project current status
    const tokenHash = typeof requestData.tokenHash === 'string' ? requestData.tokenHash : null;
    const inviteRef = tokenHash ? db.collection('invites').doc(tokenHash) : null;
    const inviteSnap = inviteRef ? await transaction.get(inviteRef) : null;

    const now = Date.now();
    const { effectiveStatus } = projectJoinStatus(
      requestData,
      roomSnap,
      inviteSnap,
      now,
      requestData.applicantUid
    );

    // 5. Handle duplicate decisions on already decided requests
    if (requestData.status === 'approved') {
      if (input.decision === 'approve') {
        // Idempotent duplicate approval: NEVER replay re-adds membership! (Defect 2)
        const receiptDoc = {
          operationId: receiptId,
          callerUid,
          operation: 'decideJoin',
          requestId,
          payloadHash: canonicalPayloadHash,
          status: 'complete',
          roomId: input.roomId,
          joinRequestId: input.joinRequestId,
          joinStatus: 'approved',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(receiptRef, receiptDoc);

        return {
          operationId: receiptId,
          status: 'complete',
          roomId: input.roomId,
          joinRequestId: input.joinRequestId,
          joinStatus: 'approved',
        };
      } else {
        throw createSafeAppError('conflict', 'Join request has already been approved', requestId, receiptId);
      }
    }

    if (requestData.status === 'rejected') {
      if (input.decision === 'reject') {
        const receiptDoc = {
          operationId: receiptId,
          callerUid,
          operation: 'decideJoin',
          requestId,
          payloadHash: canonicalPayloadHash,
          status: 'complete',
          roomId: input.roomId,
          joinRequestId: input.joinRequestId,
          joinStatus: 'rejected',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(receiptRef, receiptDoc);

        return {
          operationId: receiptId,
          status: 'complete',
          roomId: input.roomId,
          joinRequestId: input.joinRequestId,
          joinStatus: 'rejected',
        };
      } else {
        throw createSafeAppError('conflict', 'Join request has already been rejected', requestId, receiptId);
      }
    }

    if (requestData.status === 'expired' || effectiveStatus === 'expired') {
      throw createSafeAppError('conflict', 'Join request has expired', requestId, receiptId);
    }

    if (requestData.status !== 'pending') {
      throw createSafeAppError('conflict', 'Join request is no longer pending', requestId, receiptId);
    }

    if (effectiveStatus !== 'pending') {
      throw createSafeAppError('conflict', 'Join request invitation version is no longer active', requestId, receiptId);
    }

    // 6. Execute decision on pending request
    // Remove from private join queue if present
    const queueRef = db.collection('joinQueues').doc(input.roomId);
    const queueSnap = await transaction.get(queueRef);
    if (queueSnap.exists) {
      const queuedIds = Array.isArray(queueSnap.data()?.requestIds) ? queueSnap.data()!.requestIds : [];
      transaction.update(queueRef, {
        requestIds: queuedIds.filter((id: unknown) => id !== input.joinRequestId),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    if (input.decision === 'approve') {
      if (!memberIds.includes(requestData.applicantUid)) {
        if (memberIds.length >= 20) {
          throw createSafeAppError('room-busy', 'Room is at maximum capacity (20 members)', requestId, receiptId);
        }
        const rawMembers = Array.isArray(roomData.members) ? roomData.members : [];
        transaction.update(roomRef, {
          memberIds: [...memberIds, requestData.applicantUid],
          members: [...rawMembers, { uid: requestData.applicantUid, label: requestData.applicantLabel ?? '' }],
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      transaction.update(joinRequestRef, {
        status: 'approved',
        decision: 'approve',
        decidedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const receiptDoc = {
        operationId: receiptId,
        callerUid,
        operation: 'decideJoin',
        requestId,
        payloadHash: canonicalPayloadHash,
        status: 'complete',
        roomId: input.roomId,
        joinRequestId: input.joinRequestId,
        joinStatus: 'approved',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(receiptRef, receiptDoc);

      return {
        operationId: receiptId,
        status: 'complete',
        roomId: input.roomId,
        joinRequestId: input.joinRequestId,
        joinStatus: 'approved',
      };
    } else {
      transaction.update(joinRequestRef, {
        status: 'rejected',
        decision: 'reject',
        decidedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const receiptDoc = {
        operationId: receiptId,
        callerUid,
        operation: 'decideJoin',
        requestId,
        payloadHash: canonicalPayloadHash,
        status: 'complete',
        roomId: input.roomId,
        joinRequestId: input.joinRequestId,
        joinStatus: 'rejected',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(receiptRef, receiptDoc);

      return {
        operationId: receiptId,
        status: 'complete',
        roomId: input.roomId,
        joinRequestId: input.joinRequestId,
        joinStatus: 'rejected',
      };
    }
  });
}
