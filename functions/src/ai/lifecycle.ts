import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction, type DocumentReference, type DocumentData } from 'firebase-admin/firestore';
import type { CommandResult, ModerationErrorCode } from '@threadline/shared';
import { createSafeAppError } from '../utils/errors.js';
import { computePayloadHash } from '../utils/hash.js';
import { prepareContext, type ContextRow, type InferenceProvider, type ProviderAnswer, type PreparedContext } from './provider.js';
import {
  BUDGET_ID,
  RESERVATION_MICRO_USD,
  type AiPolicy,
  requireAiAccess,
  checkPricing,
  getAttemptLimit,
} from './policy.js';
import type { ModerationPort } from '../moderation/provider.js';
import {
  SUBMISSION_LEASE_MS,
  isLiveSubmission,
  settleSubmissionFailure,
  submissionReceiptResult,
  executeScreening,
} from '../moderation/submissions.js';

export interface AskInput { roomId: string; messageId: string; text: string }
export interface RetryInput { roomId: string; promptMessageId: string; generationId: string }

function checkRoom(room: DocumentData | undefined, uid: string, requestId: string): asserts room is DocumentData {
  if (!room || room.state !== 'active' || !Array.isArray(room.memberIds) || !room.memberIds.includes(uid)) {
    throw createSafeAppError('forbidden', 'Not an active member of this room.', requestId);
  }
}

export async function settleReservation(transaction: Transaction, db: Firestore, reservationRef: DocumentReference,
  reservation: DocumentData, consume: boolean): Promise<void> {
  if (reservation.state !== 'reserved') return;
  const budgetRef = db.collection('budgets').doc(BUDGET_ID);
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${reservation.requesterId}`);
  const [budgetSnap, quotaSnap] = await Promise.all([transaction.get(budgetRef), transaction.get(quotaRef)]);
  const budget = budgetSnap.data(), quota = quotaSnap.data();
  if (!budget || !quota || !Number.isSafeInteger(reservation.microUsd) || reservation.microUsd <= 0
    || !Number.isSafeInteger(budget.reservedMicroUsd) || budget.reservedMicroUsd < reservation.microUsd
    || !Number.isSafeInteger(budget.consumedMicroUsd) || budget.consumedMicroUsd < 0
    || !Number.isSafeInteger(budget.consumedMicroUsd + (consume ? reservation.microUsd : 0))
    || !Number.isSafeInteger(quota.reservedAttempts) || quota.reservedAttempts < 1
    || !Number.isSafeInteger(quota.consumedAttempts) || quota.consumedAttempts < 0) throw new Error('Inference ledger unavailable');
  transaction.update(budgetRef, { reservedMicroUsd: budget.reservedMicroUsd - reservation.microUsd,
    consumedMicroUsd: budget.consumedMicroUsd + (consume ? reservation.microUsd : 0) });
  transaction.update(quotaRef, { reservedAttempts: quota.reservedAttempts - 1,
    consumedAttempts: quota.consumedAttempts + (consume ? 1 : 0) });
  transaction.update(reservationRef, { state: consume ? 'consumed' : 'released', settledAt: FieldValue.serverTimestamp() });
}

export async function handleAskThreadline(
  db: Firestore,
  uid: string,
  label: string,
  requestId: string,
  input: AskInput,
  policy: AiPolicy,
  provider: InferenceProvider,
  moderation: ModerationPort
): Promise<CommandResult> {
  requireAiAccess(uid, requestId, policy);
  if (!input.text.trim() || input.text.length > 4000 || Buffer.byteLength(input.text, 'utf8') > 16384) {
    throw createSafeAppError('validation', 'Use a nonblank prompt of at most 4000 characters / 16 KiB.', requestId);
  }
  const now = policy.now ?? Date.now;
  const receiptId = `${uid}_askThreadline_${requestId}`;
  const submissionId = receiptId;
  const roomRef = db.collection('rooms').doc(input.roomId);
  const receiptRef = db.collection('receipts').doc(receiptId);
  const submissionRef = db.collection('submissions').doc(submissionId);
  const promptRef = roomRef.collection('messages').doc(input.messageId);
  const budgetRef = db.collection('budgets').doc(BUDGET_ID);
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${uid}`);
  const payloadHash = computePayloadHash(input);

  // 1. Pre-screening admission & claim transaction
  const admission = await db.runTransaction(async (transaction) => {
    requireAiAccess(uid, requestId, policy);
    const [roomSnap, receiptSnap, submissionSnap, promptSnap, budgetSnap, quotaSnap] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(receiptRef),
      transaction.get(submissionRef),
      transaction.get(promptRef),
      transaction.get(budgetRef),
      transaction.get(quotaRef),
    ]);
    const room = roomSnap.data();
    checkRoom(room, uid, requestId);

    if (receiptSnap.exists) {
      const receipt = receiptSnap.data()!;
      if (receipt.callerUid !== uid || receipt.payloadHash !== payloadHash) {
        throw createSafeAppError('conflict', 'Request ID already used with different payload.', requestId);
      }
      return { type: 'replay' as const, result: submissionReceiptResult(receipt, receiptId) };
    }

    if (submissionSnap.exists) {
      const sub = submissionSnap.data()!;
      if (sub.callerUid !== uid || sub.payloadHash !== payloadHash) {
        throw createSafeAppError('conflict', 'Request ID already used with different payload.', requestId, submissionId);
      }

      if (isLiveSubmission(sub, uid, payloadHash, now())) {
        return { type: 'pending' as const, result: {
          operationId: submissionId, status: 'pending', roomId: input.roomId, messageId: input.messageId,
        } as CommandResult };
      }
      return { type: 'replay' as const,
        result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, uid, payloadHash) };
    }

    if (room.maintenanceId || room.activeGenerationId) {
      throw createSafeAppError('room-busy', 'Room is busy. Keep your draft and try Ask again when it settles.', requestId);
    }
    if (promptSnap.exists) {
      throw createSafeAppError('conflict', 'Message ID already exists.', requestId);
    }

    const budget = budgetSnap.data();
    checkPricing(budget, now(), requestId, policy);
    const quota = quotaSnap.data() ?? { reservedAttempts: 0, consumedAttempts: 0 };
    if (![quota.reservedAttempts, quota.consumedAttempts].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Invalid account ledger');
    }
    const totalAttempts = quota.reservedAttempts + quota.consumedAttempts;
    const requiredMicroUsd = budget.reservedMicroUsd + budget.consumedMicroUsd + RESERVATION_MICRO_USD;
    if (!Number.isSafeInteger(totalAttempts) || !Number.isSafeInteger(requiredMicroUsd)) {
      throw new Error('Invalid account ledger');
    }
    const attemptLimit = getAttemptLimit(budget, policy);
    const attemptExhausted = attemptLimit !== null && totalAttempts >= attemptLimit;
    const monetaryExhausted = budget.allowanceMicroUsd !== null && requiredMicroUsd > budget.allowanceMicroUsd;
    if (attemptExhausted || monetaryExhausted) {
      throw createSafeAppError('budget-exhausted', 'AI lifetime allowance is exhausted. There is no automatic reset or top-up.', requestId);
    }

    // Durable claim before screening (no public prompt, reservation or fence allocated)
    transaction.create(submissionRef, {
      id: submissionId,
      operation: 'askThreadline',
      callerUid: uid,
      roomId: input.roomId,
      messageId: input.messageId,
      payloadHash,
      state: 'pending',
      leaseExpiresAt: now() + SUBMISSION_LEASE_MS,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { type: 'claimed' as const };
  });

  if (admission.type !== 'claimed') {
    return admission.result;
  }

  // 2. Exactly one content screening attempt
  const screenResult = await executeScreening(moderation, input.text);


  // 3. Atomically consume approved claim and admit generation work
  const generationId = randomUUID();
  const generationRef = roomRef.collection('generations').doc(generationId);
  const reservationRef = db.collection('reservations').doc(generationId);

  const admitted = await db.runTransaction(async (transaction) => {
    requireAiAccess(uid, requestId, policy);
    const [roomSnap, receiptSnap, submissionSnap, promptSnap, budgetSnap, quotaSnap] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(receiptRef),
      transaction.get(submissionRef),
      transaction.get(promptRef),
      transaction.get(budgetRef),
      transaction.get(quotaRef),
    ]);
    const room = roomSnap.data();
    checkRoom(room, uid, requestId);

    if (receiptSnap.exists) {
      const receipt = receiptSnap.data()!;
      if (receipt.callerUid !== uid || receipt.payloadHash !== payloadHash) {
        throw createSafeAppError('conflict', 'Invalid submission receipt', requestId, submissionId);
      }
      return { replay: true, result: submissionReceiptResult(receipt, receiptId) };
    }

    const sub = submissionSnap.data();
    if (!isLiveSubmission(sub, uid, payloadHash, now()) || screenResult.verdict !== 'allow') {
      const errorCode = isLiveSubmission(sub, uid, payloadHash, now()) && screenResult.verdict === 'block'
        ? 'screening-blocked' : 'screening-unavailable';
      return { replay: true,
        result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, uid, payloadHash, errorCode) };
    }

    if (room.maintenanceId || room.activeGenerationId) {
      throw createSafeAppError('room-busy', 'Room is busy. Keep your draft and try Ask again when it settles.', requestId);
    }
    if (promptSnap.exists) {
      throw createSafeAppError('conflict', 'Message ID already exists.', requestId);
    }

    const budget = budgetSnap.data();
    checkPricing(budget, now(), requestId, policy);
    const quota = quotaSnap.data() ?? { reservedAttempts: 0, consumedAttempts: 0 };
    if (![quota.reservedAttempts, quota.consumedAttempts].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Invalid account ledger');
    }
    const totalAttempts = quota.reservedAttempts + quota.consumedAttempts;
    const requiredMicroUsd = budget.reservedMicroUsd + budget.consumedMicroUsd + RESERVATION_MICRO_USD;
    if (!Number.isSafeInteger(totalAttempts) || !Number.isSafeInteger(requiredMicroUsd)) {
      throw new Error('Invalid account ledger');
    }
    const attemptLimit = getAttemptLimit(budget, policy);
    const attemptExhausted = attemptLimit !== null && totalAttempts >= attemptLimit;
    const monetaryExhausted = budget.allowanceMicroUsd !== null && requiredMicroUsd > budget.allowanceMicroUsd;
    if (attemptExhausted || monetaryExhausted) {
      throw createSafeAppError('budget-exhausted', 'AI lifetime allowance is exhausted. There is no automatic reset or top-up.', requestId);
    }

    const seq = room.nextSeq;
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid room sequence');
    const expiresAt = now() + 120000;

    transaction.create(promptRef, {
      id: input.messageId,
      roomId: input.roomId,
      seq,
      kind: 'human',
      intent: 'ask-ai',
      authorId: uid,
      authorLabel: label,
      text: input.text,
      version: 1,
      createdAt: FieldValue.serverTimestamp(),
      editedAt: null,
      deletedAt: null,
    });
    transaction.create(generationRef, {
      id: generationId,
      roomId: input.roomId,
      requesterId: uid,
      requesterLabel: label,
      promptMessageId: input.messageId,
      promptVersion: 1,
      contextThroughSeq: seq,
      state: 'preparing',
      expiresAt,
      startedAt: FieldValue.serverTimestamp(),
      receiptId,
      errorCode: null,
    });
    transaction.create(reservationRef, {
      roomId: input.roomId,
      generationId,
      requesterId: uid,
      receiptId,
      state: 'reserved',
      microUsd: RESERVATION_MICRO_USD,
    });
    transaction.set(quotaRef, {
      requesterId: uid,
      reservedAttempts: quota.reservedAttempts + 1,
      consumedAttempts: quota.consumedAttempts,
    });
    transaction.update(budgetRef, {
      reservedMicroUsd: budget.reservedMicroUsd + RESERVATION_MICRO_USD,
    });
    transaction.update(roomRef, {
      nextSeq: seq + 1,
      activeGenerationId: generationId,
      latestAiPromptId: input.messageId,
      latestGenerationId: generationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.delete(submissionRef);
    transaction.create(receiptRef, {
      operationId: receiptId,
      callerUid: uid,
      operation: 'askThreadline',
      payloadHash,
      roomId: input.roomId,
      messageId: input.messageId,
      generationId,
      seq,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      replay: false,
      result: {
        operationId: receiptId,
        status: 'pending',
        roomId: input.roomId,
        messageId: input.messageId,
        seq,
      } as CommandResult,
    };
  });

  if (admitted.replay) return admitted.result;

  return executeGenerationDispatch(
    db, uid, label, requestId, input.roomId, input.messageId, generationId, receiptId, admitted.result, policy, provider, moderation
  );
}

async function executeGenerationDispatch(
  db: Firestore,
  uid: string,
  label: string,
  requestId: string,
  roomId: string,
  promptMessageId: string,
  generationId: string,
  receiptId: string,
  admittedResult: CommandResult,
  policy: AiPolicy,
  provider: InferenceProvider,
  moderation: ModerationPort
): Promise<CommandResult> {
  const now = policy.now ?? Date.now;
  const roomRef = db.collection('rooms').doc(roomId);
  const generationRef = roomRef.collection('generations').doc(generationId);
  const reservationRef = db.collection('reservations').doc(generationId);
  const promptRef = roomRef.collection('messages').doc(promptMessageId);
  const receiptRef = db.collection('receipts').doc(receiptId);
  const budgetRef = db.collection('budgets').doc(BUDGET_ID);

  let context: PreparedContext | undefined;
  let answer: ProviderAnswer | undefined;
  let providerReturned = false;
  let failure: 'provider-unavailable' | 'timeout' = 'provider-unavailable';
  try {
    const generation = (await generationRef.get()).data()!;
    const rowsSnap = await roomRef.collection('messages').where('seq', '<=', generation.contextThroughSeq).orderBy('seq', 'desc').limit(32).get();
    const rows: ContextRow[] = [];
    for (let index = rowsSnap.docs.length - 1; index >= 0; index--) {
      const snapshot = rowsSnap.docs[index];
      const row = snapshot.data();
      if (row.deletedAt || row.contextState === 'stale') continue;
      if (!['human', 'ai'].includes(row.kind) || typeof row.text !== 'string'
        || !Number.isSafeInteger(row.version) || row.version < 1
        || !Number.isSafeInteger(row.seq) || row.seq < 1 || row.seq > generation.contextThroughSeq) throw new Error('Invalid context row');
      rows.push({ id: snapshot.id, kind: row.kind, text: row.text, seq: row.seq, version: row.version,
        authorLabel: typeof row.authorLabel === 'string' ? row.authorLabel : undefined,
        replyToId: typeof row.replyToId === 'string' ? row.replyToId : undefined });
    }
    context = await prepareContext(rows, promptMessageId, {
      async count(contents, signal) {
        requireAiAccess(uid, requestId, policy);
        const currentRoom = (await roomRef.get()).data();
        checkRoom(currentRoom, uid, requestId);
        if (currentRoom.activeGenerationId !== generationId || currentRoom.maintenanceId || generation.expiresAt <= now()) {
          throw createSafeAppError('room-busy', 'Generation context is no longer available.', requestId);
        }
        return provider.count(contents, signal);
      },
      generate: provider.generate,
    }, AbortSignal.timeout(20000));
    const claimed = await db.runTransaction(async transaction => {
      requireAiAccess(uid, requestId, policy);
      const [roomSnap, generationSnap, promptSnap, budgetSnap, reservationSnap] = await Promise.all([
        transaction.get(roomRef), transaction.get(generationRef), transaction.get(promptRef), transaction.get(budgetRef), transaction.get(reservationRef),
      ]);
      const room = roomSnap.data(), generation = generationSnap.data(), prompt = promptSnap.data();
      checkRoom(room, uid, requestId);
      checkPricing(budgetSnap.data(), now(), requestId, policy);
      if (!generation || generation.state !== 'preparing' || generation.expiresAt <= now() || room.maintenanceId
        || room.activeGenerationId !== generationId || !prompt || prompt.deletedAt || prompt.version !== generation.promptVersion) return false;
      if (!reservationSnap.exists || reservationSnap.data()!.state !== 'reserved') throw new Error('Reservation unavailable');
      await settleReservation(transaction, db, reservationRef, reservationSnap.data()!, true);
      transaction.update(generationRef, { state: 'dispatched' });
      return true;
    });
    if (claimed) {
      answer = await provider.generate(context, AbortSignal.timeout(45000));
      providerReturned = true;
    }
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) failure = 'timeout';
  }

  let outputScreenVerdict: 'allow' | 'block' | 'unavailable' = 'unavailable';
  if (providerReturned && typeof answer?.text === 'string' && answer.text.trim()) {
    const screenRes = await executeScreening(moderation, answer.text);
    outputScreenVerdict = screenRes.verdict;
  }

  return db.runTransaction(async transaction => {
    const [roomSnap, generationSnap, promptSnap, reservationSnap, receiptSnap] = await Promise.all([
      transaction.get(roomRef), transaction.get(generationRef), transaction.get(promptRef), transaction.get(reservationRef), transaction.get(receiptRef),
    ]);
    const room = roomSnap.data(), generation = generationSnap.data(), prompt = promptSnap.data();
    // Deletion may already have settled and removed the private state; never recreate it.
    if (!generation) return { ...admittedResult, status: 'cancelled' };
    if (!['preparing', 'dispatched'].includes(generation.state)) {
      const terminalResult = receiptSnap.exists ? submissionReceiptResult(receiptSnap.data()!, receiptId) : admittedResult;
      return { ...terminalResult,
        status: generation.state === 'succeeded' ? 'complete' : generation.state === 'cancelled' ? 'cancelled' : 'failed',
        ...(generation.errorCode === 'screening-blocked' || generation.errorCode === 'screening-unavailable'
          ? { errorCode: generation.errorCode as ModerationErrorCode } : {}) };
    }
    const valid = room?.state === 'active' && Array.isArray(room.memberIds) && room.memberIds.includes(uid)
      && room.activeGenerationId === generationId && !room.maintenanceId && generation.expiresAt > now()
      && prompt && !prompt.deletedAt && prompt.version === generation.promptVersion
      && receiptSnap.exists && receiptSnap.data()!.status === 'pending'
      && receiptSnap.data()!.callerUid === uid && (policy.localDevelopment || policy.testerUids.includes(uid));
    if (reservationSnap.exists && reservationSnap.data()!.state === 'reserved') {
      await settleReservation(transaction, db, reservationRef, reservationSnap.data()!, generation.state === 'dispatched');
    }
    const isModerationFailure = providerReturned && !!context && valid && generation.state === 'dispatched' && outputScreenVerdict !== 'allow';
    const moderationErrorCode: ModerationErrorCode | null = isModerationFailure
      ? (outputScreenVerdict === 'block' ? 'screening-blocked' : 'screening-unavailable')
      : null;
    const success = !!answer && !!context && valid && generation.state === 'dispatched' && outputScreenVerdict === 'allow';
    const state = success ? 'succeeded' : isModerationFailure ? 'failed' : generation.expiresAt <= now() || failure === 'timeout' ? 'timed-out' : valid ? 'failed' : 'cancelled';
    const finalErrorCode = success ? null : moderationErrorCode ?? (state === 'timed-out' ? 'timeout' : failure);
    if (success) {
      const seq = room!.nextSeq;
      if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid room sequence');
      const answerId = generationId;
      transaction.create(roomRef.collection('messages').doc(answerId), { id: answerId, roomId, seq,
        kind: 'ai', text: answer!.text, version: 1, replyToId: promptMessageId, replyToVersion: generation.promptVersion,
        requesterLabel: label, contextState: 'current', contextRefs: context!.refs, createdAt: FieldValue.serverTimestamp(), editedAt: null, deletedAt: null });
      transaction.update(roomRef, { nextSeq: seq + 1, activeGenerationId: null, updatedAt: FieldValue.serverTimestamp() });
      if (reservationSnap.exists) transaction.update(reservationRef, { inputTokens: answer!.inputTokens, answerTokens: answer!.answerTokens, thoughtTokens: answer!.thoughtTokens });
    } else if (room?.state === 'active' && room.activeGenerationId === generationId) {
      transaction.update(roomRef, { activeGenerationId: null });
    }
    transaction.update(generationRef, { state, errorCode: finalErrorCode });
    if (receiptSnap.exists) transaction.update(receiptRef, {
      status: success ? 'complete' : state === 'cancelled' ? 'cancelled' : 'failed',
      ...(moderationErrorCode ? { errorCode: moderationErrorCode } : {}),
    });
    return {
      ...admittedResult,
      status: success ? 'complete' : state === 'cancelled' ? 'cancelled' : 'failed',
      ...(moderationErrorCode ? { errorCode: moderationErrorCode } : {}),
    };
  });
}

export async function handleRetryAiReply(
  db: Firestore,
  uid: string,
  label: string,
  requestId: string,
  input: RetryInput,
  policy: AiPolicy,
  provider: InferenceProvider,
  moderation: ModerationPort
): Promise<CommandResult> {
  requireAiAccess(uid, requestId, policy);
  if (!input.roomId || !input.promptMessageId || !input.generationId) {
    throw createSafeAppError('validation', 'roomId, promptMessageId, and generationId are required.', requestId);
  }
  const now = policy.now ?? Date.now;
  const receiptId = `${uid}_retryAiReply_${requestId}`;
  const roomRef = db.collection('rooms').doc(input.roomId);
  const receiptRef = db.collection('receipts').doc(receiptId);
  const submissionRef = db.collection('submissions').doc(receiptId);
  const failedGenRef = roomRef.collection('generations').doc(input.generationId);
  const promptRef = roomRef.collection('messages').doc(input.promptMessageId);
  const budgetRef = db.collection('budgets').doc(BUDGET_ID);
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${uid}`);
  const payloadHash = computePayloadHash(input);
  const newGenerationId = randomUUID();
  const newGenRef = roomRef.collection('generations').doc(newGenerationId);
  const reservationRef = db.collection('reservations').doc(newGenerationId);

  const precheck = await db.runTransaction(async transaction => {
    requireAiAccess(uid, requestId, policy);
    const [roomSnap, receiptSnap, failedGenSnap, promptSnap, budgetSnap, quotaSnap, submissionSnap] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(receiptRef),
      transaction.get(failedGenRef),
      transaction.get(promptRef),
      transaction.get(budgetRef),
      transaction.get(quotaRef),
      transaction.get(submissionRef),
    ]);
    const room = roomSnap.data();
    checkRoom(room, uid, requestId);

    // Replay check before latest generation check so replay of admitted retry never redispatches
    if (receiptSnap.exists) {
      const receipt = receiptSnap.data()!;
      if (receipt.callerUid !== uid || receipt.payloadHash !== payloadHash) throw createSafeAppError('conflict', 'Request ID already used with different payload.', requestId);
      return { replay: true as const, result: submissionReceiptResult(receipt, receiptId) };
    }

    if (submissionSnap.exists) {
      const sub = submissionSnap.data()!;
      if (sub.callerUid !== uid || sub.payloadHash !== payloadHash) {
        throw createSafeAppError('conflict', 'Invalid submission claim.', requestId, receiptId);
      }
      return { replay: true as const, result: isLiveSubmission(sub, uid, payloadHash, now())
        ? { operationId: receiptId, status: 'pending', roomId: input.roomId, messageId: input.promptMessageId } as CommandResult
        : settleSubmissionFailure(transaction, submissionSnap, receiptSnap, uid, payloadHash) };
    }

    if (room.maintenanceId || room.activeGenerationId) {
      throw createSafeAppError('room-busy', 'Room is busy. Keep your draft and try Ask again when it settles.', requestId);
    }

    const failedGen = failedGenSnap.data();
    if (!failedGenSnap.exists || !failedGen) {
      throw createSafeAppError('missing', 'Generation to retry does not exist.', requestId);
    }
    if (failedGen.roomId !== input.roomId) {
      throw createSafeAppError('missing', 'Generation to retry does not exist in this room.', requestId);
    }
    if (failedGen.requesterId !== uid) {
      throw createSafeAppError('forbidden', 'Only the author of the question can retry it.', requestId);
    }
    if (failedGen.state === 'succeeded') {
      throw createSafeAppError('conflict', 'AI reply has already succeeded.', requestId);
    }
    if (!['failed', 'timed-out'].includes(failedGen.state)) {
      throw createSafeAppError('conflict', 'Generation is not in a retryable state.', requestId);
    }
    if (failedGen.promptMessageId !== input.promptMessageId) {
      throw createSafeAppError('conflict', 'Generation prompt mismatch.', requestId);
    }

    const prompt = promptSnap.data();
    if (!promptSnap.exists || !prompt) {
      throw createSafeAppError('missing', 'Prompt message does not exist.', requestId);
    }
    if (prompt.authorId !== uid) {
      throw createSafeAppError('forbidden', 'Only the author of the question can retry it.', requestId);
    }
    if (prompt.deletedAt) {
      throw createSafeAppError('conflict', 'Prompt message has been deleted.', requestId);
    }
    if (prompt.version !== failedGen.promptVersion) {
      throw createSafeAppError('conflict', 'Prompt message has been edited.', requestId);
    }
    if (prompt.kind !== 'human' || prompt.intent !== 'ask-ai') {
      throw createSafeAppError('conflict', 'Target message is not an AI prompt.', requestId);
    }

    if (room.latestGenerationId !== input.generationId || room.latestAiPromptId !== input.promptMessageId) {
      throw createSafeAppError('conflict', 'A newer Ask has already been started or generation is not the latest.', requestId);
    }

    const contextThroughSeq = failedGen.contextThroughSeq;
    if (!Number.isSafeInteger(contextThroughSeq) || contextThroughSeq < 1 || contextThroughSeq > room.nextSeq) {
      throw new Error('Invalid origin generation sequence cutoff');
    }
    if (typeof prompt.text !== 'string' || !prompt.text.trim()) {
      throw createSafeAppError('conflict', 'Prompt is unavailable.', requestId);
    }

    const budget = budgetSnap.data();
    checkPricing(budget, now(), requestId, policy);
    const quota = quotaSnap.data() ?? { reservedAttempts: 0, consumedAttempts: 0 };
    if (![quota.reservedAttempts, quota.consumedAttempts].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Invalid account ledger');
    }
    const totalAttempts = quota.reservedAttempts + quota.consumedAttempts;
    const requiredMicroUsd = budget.reservedMicroUsd + budget.consumedMicroUsd + RESERVATION_MICRO_USD;
    if (!Number.isSafeInteger(totalAttempts) || !Number.isSafeInteger(requiredMicroUsd)) {
      throw new Error('Invalid account ledger');
    }
    const attemptLimit = getAttemptLimit(budget, policy);
    const attemptExhausted = attemptLimit !== null && totalAttempts >= attemptLimit;
    const monetaryExhausted = budget.allowanceMicroUsd !== null && requiredMicroUsd > budget.allowanceMicroUsd;
    if (attemptExhausted || monetaryExhausted) {
      throw createSafeAppError('budget-exhausted', 'AI lifetime allowance is exhausted. There is no automatic reset or top-up.', requestId);
    }

    transaction.create(submissionRef, {
      id: receiptId, operation: 'retryAiReply', callerUid: uid, payloadHash,
      roomId: input.roomId, messageId: input.promptMessageId, expectedVersion: prompt.version,
      generationId: input.generationId, state: 'pending', leaseExpiresAt: now() + SUBMISSION_LEASE_MS,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      replay: false as const,
      promptText: prompt.text as string,
      promptVersion: failedGen.promptVersion as number,
      contextThroughSeq,
    };
  });

  if (precheck.replay) return precheck.result;

  // Screen existing approved prompt before new dispatch
  const screenResult = await executeScreening(moderation, precheck.promptText);

  const admitted = await db.runTransaction(async transaction => {
    requireAiAccess(uid, requestId, policy);
    const [roomSnap, receiptSnap, budgetSnap, quotaSnap, submissionSnap, failedGenSnap, promptSnap] = await Promise.all([
      transaction.get(roomRef),
      transaction.get(receiptRef),
      transaction.get(budgetRef),
      transaction.get(quotaRef),
      transaction.get(submissionRef),
      transaction.get(failedGenRef),
      transaction.get(promptRef),
    ]);
    const room = roomSnap.data();
    checkRoom(room, uid, requestId);

    if (receiptSnap.exists) {
      const receipt = receiptSnap.data()!;
      if (receipt.callerUid !== uid || receipt.payloadHash !== payloadHash) {
        throw createSafeAppError('conflict', 'Invalid submission receipt.', requestId, receiptId);
      }
      return { replay: true as const, result: submissionReceiptResult(receipt, receiptId) };
    }

    const sub = submissionSnap.data();
    if (!isLiveSubmission(sub, uid, payloadHash, now()) || screenResult.verdict !== 'allow') {
      const errorCode = isLiveSubmission(sub, uid, payloadHash, now()) && screenResult.verdict === 'block'
        ? 'screening-blocked' : 'screening-unavailable';
      return { replay: true as const,
        result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, uid, payloadHash, errorCode) };
    }

    const failedGen = failedGenSnap.data(), prompt = promptSnap.data();
    if (!failedGen || failedGen.roomId !== input.roomId || failedGen.requesterId !== uid
      || !['failed', 'timed-out'].includes(failedGen.state) || failedGen.promptMessageId !== input.promptMessageId
      || failedGen.promptVersion !== precheck.promptVersion || failedGen.contextThroughSeq !== precheck.contextThroughSeq
      || !prompt || prompt.authorId !== uid || prompt.deletedAt || prompt.kind !== 'human' || prompt.intent !== 'ask-ai'
      || prompt.version !== precheck.promptVersion || prompt.text !== precheck.promptText
      || sub!.expectedVersion !== precheck.promptVersion || sub!.generationId !== input.generationId
      || room.latestGenerationId !== input.generationId || room.latestAiPromptId !== input.promptMessageId) {
      return { replay: true as const,
        result: settleSubmissionFailure(transaction, submissionSnap, receiptSnap, uid, payloadHash) };
    }

    if (room.maintenanceId || room.activeGenerationId) {
      throw createSafeAppError('room-busy', 'Room is busy. Keep your draft and try Ask again when it settles.', requestId);
    }

    const budget = budgetSnap.data();
    checkPricing(budget, now(), requestId, policy);
    const quota = quotaSnap.data() ?? { reservedAttempts: 0, consumedAttempts: 0 };
    if (![quota.reservedAttempts, quota.consumedAttempts].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('Invalid account ledger');
    }
    const totalAttempts = quota.reservedAttempts + quota.consumedAttempts;
    const requiredMicroUsd = budget.reservedMicroUsd + budget.consumedMicroUsd + RESERVATION_MICRO_USD;
    if (!Number.isSafeInteger(totalAttempts) || !Number.isSafeInteger(requiredMicroUsd)) {
      throw new Error('Invalid account ledger');
    }
    const attemptLimit = getAttemptLimit(budget, policy);
    const attemptExhausted = attemptLimit !== null && totalAttempts >= attemptLimit;
    const monetaryExhausted = budget.allowanceMicroUsd !== null && requiredMicroUsd > budget.allowanceMicroUsd;
    if (attemptExhausted || monetaryExhausted) {
      throw createSafeAppError('budget-exhausted', 'AI lifetime allowance is exhausted. There is no automatic reset or top-up.', requestId);
    }

    const expiresAt = now() + 120000;
    transaction.create(newGenRef, {
      id: newGenerationId,
      roomId: input.roomId,
      requesterId: uid,
      requesterLabel: label,
      promptMessageId: input.promptMessageId,
      promptVersion: precheck.promptVersion,
      contextThroughSeq: precheck.contextThroughSeq,
      state: 'preparing',
      expiresAt,
      startedAt: FieldValue.serverTimestamp(),
      receiptId,
      errorCode: null,
      retriedFromGenerationId: input.generationId,
    });
    transaction.create(reservationRef, {
      roomId: input.roomId,
      generationId: newGenerationId,
      requesterId: uid,
      receiptId,
      state: 'reserved',
      microUsd: RESERVATION_MICRO_USD,
    });
    transaction.set(quotaRef, {
      requesterId: uid,
      reservedAttempts: quota.reservedAttempts + 1,
      consumedAttempts: quota.consumedAttempts,
    });
    transaction.update(budgetRef, {
      reservedMicroUsd: budget.reservedMicroUsd + RESERVATION_MICRO_USD,
    });
    transaction.update(roomRef, {
      activeGenerationId: newGenerationId,
      latestGenerationId: newGenerationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.delete(submissionRef);
    transaction.create(receiptRef, {
      operationId: receiptId,
      callerUid: uid,
      operation: 'retryAiReply',
      payloadHash,
      roomId: input.roomId,
      messageId: input.promptMessageId,
      promptMessageId: input.promptMessageId,
      generationId: newGenerationId,
      failedGenerationId: input.generationId,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      replay: false as const,
      result: {
        operationId: receiptId,
        status: 'pending',
        roomId: input.roomId,
        messageId: input.promptMessageId,
      } as CommandResult,
    };
  });

  if (admitted.replay) return admitted.result;

  return executeGenerationDispatch(
    db, uid, label, requestId, input.roomId, input.promptMessageId, newGenerationId, receiptId, admitted.result, policy, provider, moderation
  );
}
