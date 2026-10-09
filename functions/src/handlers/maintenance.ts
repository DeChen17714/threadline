import { FieldPath, FieldValue, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { CommandResult } from '@threadline/shared';
import { computePayloadHash } from '../utils/hash.js';
import { createSafeAppError } from '../utils/errors.js';
import { settleReservation } from '../ai/lifecycle.js';

export interface DeleteRoomInput {
  readonly roomId: string;
}

export interface ResumeMaintenanceInput {
  readonly operationId: string;
}

export interface ListPendingOperationsInput {
  readonly cursor: string | null;
}

export async function handleDeleteRoom(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: DeleteRoomInput
): Promise<CommandResult> {
  const receiptId = `${callerUid}_deleteRoom_${requestId}`;
  const canonicalPayloadHash = computePayloadHash({
    roomId: input.roomId,
  });
  const jobId = `${callerUid}_deleteRoom_${input.roomId}`;

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

      const jobRef = db.collection('maintenanceJobs').doc(jobId);
      const jobSnap = await transaction.get(jobRef);
      if (jobSnap.exists) {
        const jobData = jobSnap.data()!;
        if (jobData.callerUid !== callerUid || jobData.roomId !== input.roomId || jobData.operation !== 'deleteRoom') {
          throw createSafeAppError('forbidden', 'Not authorized for this operation', requestId);
        }
        return {
          operationId: jobId,
          status: (jobData.status === 'pending' || jobData.status === 'failed' || jobData.status === 'cancelled') ? jobData.status : 'complete',
          roomId: input.roomId,
          deletedCount: typeof jobData.deletedCount === 'number' ? jobData.deletedCount : 0,
        };
      }

      throw createSafeAppError('missing', 'Deletion job is unavailable; cleanup is not confirmed', requestId);
    }

    const jobRef = db.collection('maintenanceJobs').doc(jobId);
    const jobSnap = await transaction.get(jobRef);

    if (jobSnap.exists) {
      const jobData = jobSnap.data()!;
      if (jobData.callerUid !== callerUid || jobData.roomId !== input.roomId || jobData.operation !== 'deleteRoom') {
        throw createSafeAppError(
          'forbidden',
          'Not authorized for this operation',
          requestId,
          jobId
        );
      }

      // Replay with new requestId records receipt and returns existing job
      const now = FieldValue.serverTimestamp();
      const receiptDoc = {
        operationId: jobId,
        callerUid,
        operation: 'deleteRoom',
        requestId,
        payloadHash: canonicalPayloadHash,
        status: (jobData.status === 'pending' || jobData.status === 'failed' || jobData.status === 'cancelled') ? jobData.status : 'complete',
        roomId: input.roomId,
        createdAt: now,
        updatedAt: now,
      };
      transaction.set(receiptRef, receiptDoc);

      return {
        operationId: jobId,
        status: (jobData.status === 'pending' || jobData.status === 'failed' || jobData.status === 'cancelled') ? jobData.status : 'complete',
        roomId: input.roomId,
        deletedCount: typeof jobData.deletedCount === 'number' ? jobData.deletedCount : 0,
      };
    }

    const roomRef = db.collection('rooms').doc(input.roomId);
    const roomSnap = await transaction.get(roomRef);

    if (!roomSnap.exists) {
      throw createSafeAppError('missing', 'Room not found', requestId, jobId);
    }

    const roomData = roomSnap.data()!;
    const rawMemberIds = roomData.memberIds;
    const memberIds = Array.isArray(rawMemberIds)
      ? rawMemberIds.filter((id): id is string => typeof id === 'string')
      : [];

    if (roomData.creatorId !== callerUid) {
      throw createSafeAppError(
        'forbidden',
        'Only the room creator can delete this room',
        requestId,
        jobId
      );
    }

    if (!memberIds.includes(callerUid)) {
      throw createSafeAppError(
        'forbidden',
        'Not an active member of this room',
        requestId,
        jobId
      );
    }

    if (roomData.state !== 'active') {
      throw createSafeAppError(
        'forbidden',
        'Room is not active',
        requestId,
        jobId
      );
    }
    const existingMaintenanceId = typeof roomData.maintenanceId === 'string' && roomData.maintenanceId.length > 0
      ? roomData.maintenanceId
      : null;
    const preemptedJobRef = existingMaintenanceId && existingMaintenanceId !== jobId
      ? db.collection('maintenanceJobs').doc(existingMaintenanceId)
      : null;
    const preemptedJobSnap = preemptedJobRef ? await transaction.get(preemptedJobRef) : null;

    const now = FieldValue.serverTimestamp();

    if (preemptedJobSnap && preemptedJobSnap.exists) {
      const preemptedData = preemptedJobSnap.data()!;
      if (preemptedData.status === 'pending' || preemptedData.status === 'failed') {
        transaction.update(preemptedJobRef!, {
          status: 'cancelled',
          errorCode: 'preempted-by-deletion',
          updatedAt: now,
        });
      }
    }

    transaction.update(roomRef, {
      state: 'deleting',
      invitationVersion: FieldValue.increment(1),
      maintenanceId: jobId,
      maintenanceState: null,
      activeGenerationId: null,
      latestAiPromptId: null,
      updatedAt: now,
    });

    const jobDoc = {
      operationId: jobId,
      callerUid,
      roomId: input.roomId,
      operation: 'deleteRoom',
      status: 'pending',
      deletedCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const receiptDoc = {
      operationId: jobId,
      callerUid,
      operation: 'deleteRoom',
      requestId,
      payloadHash: canonicalPayloadHash,
      status: 'pending',
      roomId: input.roomId,
      createdAt: now,
      updatedAt: now,
    };

    transaction.set(jobRef, jobDoc);
    transaction.set(receiptRef, receiptDoc);

    return {
      operationId: jobId,
      status: 'pending',
      roomId: input.roomId,
      deletedCount: 0,
    };
  });
}

export async function handleResumeMaintenance(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: ResumeMaintenanceInput
): Promise<CommandResult> {
  const jobRef = db.collection('maintenanceJobs').doc(input.operationId);
  const initialJobSnap = await jobRef.get();

  if (!initialJobSnap.exists) {
    throw createSafeAppError('missing', 'Operation not found', requestId, input.operationId);
  }

  const initialJobData = initialJobSnap.data()!;

  if (initialJobData.operation === 'invalidateContext') {
    return await handleResumeInvalidateContext(db, callerUid, requestId, input, initialJobData);
  }

  if (initialJobData.callerUid !== callerUid) {
    throw createSafeAppError('forbidden', 'Not authorized for this operation', requestId, input.operationId);
  }

  if (initialJobData.operation !== 'deleteRoom') {
    throw createSafeAppError('validation', 'Operation is not a room deletion', requestId, input.operationId);
  }
  if (initialJobData.status === 'complete') {
    return {
      operationId: input.operationId,
      status: 'complete',
      roomId: initialJobData.roomId as string,
      deletedCount: typeof initialJobData.deletedCount === 'number' ? initialJobData.deletedCount : 0,
    };
  }

  const roomId = initialJobData.roomId as string;
  const roomRef = db.collection('rooms').doc(roomId);

  try {
    return await db.runTransaction(async (transaction) => {
      const jobSnap = await transaction.get(jobRef);
      if (!jobSnap.exists) {
        throw createSafeAppError('missing', 'Operation not found', requestId, input.operationId);
      }
      const jobData = jobSnap.data()!;
      if (jobData.callerUid !== callerUid) {
        throw createSafeAppError('forbidden', 'Not authorized for this operation', requestId, input.operationId);
      }
      if (jobData.status === 'complete') {
        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
          deletedCount: typeof jobData.deletedCount === 'number' ? jobData.deletedCount : 0,
        };
      }

      const roomSnap = await transaction.get(roomRef);
      if (roomSnap.exists) {
        const roomData = roomSnap.data()!;
        if (roomData.state !== 'deleting' || roomData.maintenanceId !== input.operationId) {
          // Fence mismatch: persist failed status metadata without deleting
          transaction.update(jobRef, {
            status: 'failed',
            errorCode: 'fence-mismatch',
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            operationId: input.operationId,
            status: 'failed',
            roomId,
            deletedCount: typeof jobData.deletedCount === 'number' ? jobData.deletedCount : 0,
          };
        }
      }

      // Cancel active work first, including already-consumed dispatched reservations.
      const pendingGenerations = await transaction.get(
        roomRef.collection('generations').where('state', 'in', ['preparing', 'dispatched']).limit(1)
      );
      const reservations = await transaction.get(db.collection('reservations').where('roomId', '==', roomId).limit(200));
      const pendingGeneration = pendingGenerations.docs[0];
      const reserved = reservations.docs.find((doc) => doc.data().state === 'reserved');
      if (pendingGeneration || reserved) {
        const generationRef = pendingGeneration?.ref ?? roomRef.collection('generations').doc(reserved!.data().generationId);
        const generationSnap = pendingGeneration ?? await transaction.get(generationRef);
        const reservationSnap = pendingGeneration
          ? await transaction.get(db.collection('reservations').doc(pendingGeneration.id))
          : reserved!;
        if (!reservationSnap.exists) {
          throw createSafeAppError('conflict', 'Generation reservation is unavailable', requestId, input.operationId);
        }
        const reservation = reservationSnap.data()!;
        const receiptRef = typeof reservation.receiptId === 'string' ? db.collection('receipts').doc(reservation.receiptId) : null;
        const receiptSnap = receiptRef ? await transaction.get(receiptRef) : null;
        if (reservation.state === 'reserved') {
          await settleReservation(transaction, db, reservationSnap.ref, reservation, generationSnap.data()?.state !== 'preparing');
        }
        if (generationSnap.exists && ['preparing', 'dispatched'].includes(generationSnap.data()!.state)) {
          transaction.update(generationRef, { state: 'cancelled', errorCode: null });
        }
        if (receiptRef && receiptSnap?.data()?.status === 'pending') transaction.update(receiptRef, { status: 'cancelled' });
        transaction.delete(reservationSnap.ref);
        const deletedCount = (Number(jobData.deletedCount) || 0) + 1;
        transaction.update(jobRef, { status: 'pending', deletedCount, updatedAt: FieldValue.serverTimestamp() });
        return { operationId: input.operationId, status: 'pending', roomId, deletedCount };
      }
      if (!reservations.empty) {
        if (reservations.docs.some((doc) => !['consumed', 'released'].includes(doc.data().state))) {
          throw createSafeAppError('conflict', 'Reservation state is unavailable', requestId, input.operationId);
        }
        for (const reservation of reservations.docs) transaction.delete(reservation.ref);
        const deletedCount = (Number(jobData.deletedCount) || 0) + reservations.size;
        transaction.update(jobRef, { status: 'pending', deletedCount, updatedAt: FieldValue.serverTimestamp() });
        return { operationId: input.operationId, status: 'pending', roomId, deletedCount };
      }
      // Read at most 200 descendants, before any writes. An empty pass is the
      // only finalization pass, so the parent never becomes a 201st deletion.
      const descendantQueries = [
        db.collection('invites').where('roomId', '==', roomId),
        roomRef.collection('messages'),
        roomRef.collection('generations'),
      ];
      const docsToDelete: QueryDocumentSnapshot[] = [];
      for (const query of descendantQueries) {
        const remaining = 200 - docsToDelete.length;
        if (remaining === 0) break;
        const snapshot = await transaction.get(query.limit(remaining));
        docsToDelete.push(...snapshot.docs);
      }
      for (const doc of docsToDelete) transaction.delete(doc.ref);

      const currentDeletedCount = typeof jobData.deletedCount === 'number' ? jobData.deletedCount : 0;
      const newDeletedCount = currentDeletedCount + docsToDelete.length;

      if (docsToDelete.length === 0) {
        // All descendants removed: delete parent room last in same transaction if present
        if (roomSnap.exists) {
          transaction.delete(roomRef);
        }

        transaction.update(jobRef, {
          status: 'complete',
          deletedCount: newDeletedCount,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
          deletedCount: newDeletedCount,
        };
      }

      // More descendants remain: update deletedCount atomically and keep pending
      transaction.update(jobRef, {
        status: 'pending',
        deletedCount: newDeletedCount,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        operationId: input.operationId,
        status: 'pending',
        roomId,
        deletedCount: newDeletedCount,
      };
    });
  } catch (err: unknown) {
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(jobRef);
        const data = snapshot.data();
        if (data?.callerUid === callerUid && data.operation === 'deleteRoom' && data.status !== 'complete') {
          transaction.update(jobRef, {
            status: 'failed',
            errorCode: 'cleanup-error',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });
    } catch {
      // Ignore secondary error if storage unreachable
    }
    throw err;
  }
}

async function handleResumeInvalidateContext(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: ResumeMaintenanceInput,
  initialJobData: FirebaseFirestore.DocumentData
): Promise<CommandResult> {
  const roomId = initialJobData.roomId as string;
  const roomRef = db.collection('rooms').doc(roomId);
  const initialRoomSnap = await roomRef.get();

  if (!initialRoomSnap.exists) {
    throw createSafeAppError('forbidden', 'Room no longer exists', requestId, input.operationId);
  }

  const initialRoomData = initialRoomSnap.data()!;
  const memberIds = Array.isArray(initialRoomData.memberIds)
    ? initialRoomData.memberIds.filter((id): id is string => typeof id === 'string')
    : [];

  if (initialRoomData.state !== 'active' || !memberIds.includes(callerUid)) {
    throw createSafeAppError('forbidden', 'Not authorized for this operation', requestId, input.operationId);
  }

  if (initialJobData.status === 'complete') {
    return {
      operationId: input.operationId,
      status: 'complete',
      roomId,
    };
  }

  if (initialJobData.status === 'cancelled') {
    throw createSafeAppError('conflict', 'Operation was cancelled', requestId, input.operationId);
  }


  const jobRef = db.collection('maintenanceJobs').doc(input.operationId);

  try {
    return await db.runTransaction(async (transaction) => {
      const jobSnap = await transaction.get(jobRef);
      if (!jobSnap.exists) {
        throw createSafeAppError('missing', 'Operation not found', requestId, input.operationId);
      }
      const jobData = jobSnap.data()!;
      if (jobData.status === 'complete') {
        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
        };
      }
      if (jobData.status === 'cancelled') {
        throw createSafeAppError('conflict', 'Operation was cancelled', requestId, input.operationId);
      }

      const roomSnap = await transaction.get(roomRef);
      if (!roomSnap.exists) {
        throw createSafeAppError('forbidden', 'Room no longer exists', requestId, input.operationId);
      }
      const roomData = roomSnap.data()!;
      const rawMembers = roomData.memberIds;
      const currentMembers = Array.isArray(rawMembers)
        ? rawMembers.filter((id): id is string => typeof id === 'string')
        : [];
      if (roomData.state !== 'active' || !currentMembers.includes(callerUid)) {
        throw createSafeAppError('forbidden', 'Not an active member of this room', requestId, input.operationId);
      }

      if (roomData.maintenanceId !== input.operationId) {
        throw createSafeAppError('conflict', 'Maintenance fence mismatch', requestId, input.operationId);
      }

      const cursorSeq = typeof jobData.cursorSeq === 'number'
        ? jobData.cursorSeq
        : (typeof jobData.editedSeq === 'number' ? jobData.editedSeq + 1 : 1);
      const highwaterSeq = typeof jobData.highwaterSeq === 'number' ? jobData.highwaterSeq : 0;

      if (cursorSeq > highwaterSeq) {
        transaction.update(jobRef, {
          status: 'complete',
          errorCode: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(roomRef, {
          maintenanceId: null,
          maintenanceState: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
        };
      }

      const aiQuery = roomRef.collection('messages')
        .where('kind', '==', 'ai')
        .where('seq', '>=', cursorSeq)
        .where('seq', '<=', highwaterSeq)
        .orderBy('seq', 'asc')
        .limit(20);

      const aiSnap = await transaction.get(aiQuery);

      if (aiSnap.empty) {
        transaction.update(jobRef, {
          status: 'complete',
          errorCode: null,
          cursorSeq: highwaterSeq + 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(roomRef, {
          maintenanceId: null,
          maintenanceState: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
        };
      }

      const aiDocs = aiSnap.docs;
      const referencedIds = new Set<string>();

      for (const doc of aiDocs) {
        const data = doc.data();
        if (!Array.isArray(data.contextRefs) || data.contextRefs.length > 32) {
          throw createSafeAppError('validation', 'Malformed contextRefs on message', requestId, input.operationId);
        }
        for (const ref of data.contextRefs) {
          if (!ref || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1) {
            throw createSafeAppError('validation', 'Malformed contextRef entry', requestId, input.operationId);
          }
          referencedIds.add(ref.id);
        }
      }

      const aiDocMap = new Map<string, FirebaseFirestore.DocumentData>();
      for (const doc of aiDocs) {
        aiDocMap.set(doc.id, doc.data());
      }

      const toFetch = Array.from(referencedIds).filter((id) => !aiDocMap.has(id));
      const fetchedSnaps = await Promise.all(
        toFetch.map((id) => transaction.get(roomRef.collection('messages').doc(id)))
      );

      const depMap = new Map<string, FirebaseFirestore.DocumentData>();
      for (const [id, data] of aiDocMap.entries()) {
        depMap.set(id, data);
      }
      for (let i = 0; i < toFetch.length; i++) {
        const snap = fetchedSnaps[i];
        if (!snap.exists) {
          throw createSafeAppError('validation', `Referenced message ${toFetch[i]} not found`, requestId, input.operationId);
        }
        depMap.set(toFetch[i], snap.data()!);
      }

      const stagedStaleIds = new Set<string>();
      let newlyInvalidatedCount = 0;

      for (const doc of aiDocs) {
        const data = doc.data();
        if (data.contextState === 'stale') {
          stagedStaleIds.add(doc.id);
          if (
            jobData.mutationKind === 'delete' &&
            data.replyToId === jobData.messageId &&
            Array.isArray(data.contextRefs) &&
            data.contextRefs.some(
              (ref: { id: string; version: number }) =>
                ref.id === jobData.messageId && ref.version < jobData.targetVersion
            ) &&
            data.contextReason !== 'deleted-message'
          ) {
            newlyInvalidatedCount++;
            transaction.update(doc.ref, {
              contextReason: 'deleted-message',
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          continue;
        }

        let isStale = false;
        let contextReason: 'earlier-version' | 'earlier-context-changed' | 'deleted-message' | null = null;

        // 1. Direct reply check
        const isDirectReply = data.replyToId === jobData.messageId;
        if (isDirectReply) {
          const editedRef = Array.isArray(data.contextRefs)
            ? data.contextRefs.find((ref: { id: string; version: number }) => ref.id === jobData.messageId)
            : undefined;
          if (editedRef && editedRef.version < jobData.targetVersion) {
            isStale = true;
            contextReason = jobData.mutationKind === 'delete' ? 'deleted-message' : 'earlier-version';
          }
        }

        // 2. Indirect dependencies check
        if (!isStale && Array.isArray(data.contextRefs)) {
          for (const ref of data.contextRefs) {
            if (ref.id === jobData.messageId) {
              if (ref.version < jobData.targetVersion) {
                isStale = true;
                contextReason = 'earlier-context-changed';
                break;
              }
            } else if (stagedStaleIds.has(ref.id)) {
              isStale = true;
              contextReason = 'earlier-context-changed';
              break;
            } else {
              const depDoc = depMap.get(ref.id);
              if (depDoc?.kind === 'ai' && depDoc.contextState === 'stale') {
                isStale = true;
                contextReason = 'earlier-context-changed';
                break;
              }
            }
          }
        }

        if (isStale && contextReason) {
          stagedStaleIds.add(doc.id);
          newlyInvalidatedCount++;
          transaction.update(doc.ref, {
            contextState: 'stale',
            contextReason,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      const lastProcessedSeq = aiDocs[aiDocs.length - 1].data().seq;
      const totalInvalidatedCount =
        (typeof jobData.invalidatedCount === 'number' ? jobData.invalidatedCount : 0) + newlyInvalidatedCount;

      const isFinished = aiDocs.length < 20 || lastProcessedSeq >= highwaterSeq;

      if (isFinished) {
        transaction.update(jobRef, {
          status: 'complete',
          errorCode: null,
          cursorSeq: lastProcessedSeq + 1,
          invalidatedCount: totalInvalidatedCount,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.update(roomRef, {
          maintenanceId: null,
          maintenanceState: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          operationId: input.operationId,
          status: 'complete',
          roomId,
        };
      } else {
        transaction.update(jobRef, {
          status: 'pending',
          errorCode: null,
          cursorSeq: lastProcessedSeq + 1,
          invalidatedCount: totalInvalidatedCount,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          operationId: input.operationId,
          status: 'pending',
          roomId,
        };
      }
    });
  } catch (err: unknown) {
    // Record a recoverable failure only while the same active room fence is owned.
    try {
      await db.runTransaction(async transaction => {
        const [snapshot, roomSnapshot] = await Promise.all([transaction.get(jobRef), transaction.get(roomRef)]);
        const data = snapshot.data(), room = roomSnapshot.data();
        if (data && ['pending', 'failed'].includes(data.status) && room?.state === 'active'
          && room.maintenanceId === input.operationId && Array.isArray(room.memberIds) && room.memberIds.includes(callerUid)) {
          transaction.update(jobRef, { status: 'failed', errorCode: 'invalidation-error', updatedAt: FieldValue.serverTimestamp() });
        }
      });
    } catch {
      // The original failure is authoritative; the persisted fence remains resumable.
    }
    throw err;
  }
}

export async function handleListPendingOperations(
  db: Firestore,
  callerUid: string,
  requestId: string,
  input: ListPendingOperationsInput
): Promise<CommandResult> {
  const PAGE_SIZE = 20;

  let query = db
    .collection('maintenanceJobs')
    .where('callerUid', '==', callerUid)
    .where('status', 'in', ['pending', 'failed'])
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(PAGE_SIZE + 1);

  if (input.cursor) {
    query = query.startAfter(input.cursor);
  }

  const snap = await query.get();
  const docs = snap.docs;
  const hasMore = docs.length > PAGE_SIZE;
  const pageDocs = hasMore ? docs.slice(0, PAGE_SIZE) : docs;
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null;

  const operations = pageDocs.map((docSnap) => {
    const data = docSnap.data();
    return {
      operationId: docSnap.id,
      roomId: typeof data.roomId === 'string' ? data.roomId : '',
      status: (data.status === 'pending' || data.status === 'failed' || data.status === 'cancelled') ? data.status : 'complete',
      deletedCount: typeof data.deletedCount === 'number' ? data.deletedCount : 0,
    };
  });

  return {
    operationId: requestId,
    status: 'complete',
    operations,
    nextCursor,
  };
}
