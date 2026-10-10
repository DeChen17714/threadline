import { FieldValue, type DocumentData, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import type { CommandResult, ModerationErrorCode } from '@threadline/shared';
import type { ModerationPort, ModerationResult } from './provider.js';
import { MODERATION_POLICY_VERSION } from './provider.js';

export const SUBMISSION_LEASE_MS = 30_000;

export function isLiveSubmission(
  submission: DocumentData | undefined,
  callerUid: string,
  payloadHash: string,
  now = Date.now()
): boolean {
  return submission?.callerUid === callerUid && submission.payloadHash === payloadHash &&
    submission.state === 'pending' && typeof submission.leaseExpiresAt === 'number' &&
    Number.isFinite(submission.leaseExpiresAt) && submission.leaseExpiresAt > now;
}

export function submissionReceiptResult(data: DocumentData, id: string): CommandResult {
  const status = data.status === 'complete' || data.status === 'pending' || data.status === 'cancelled'
    ? data.status : 'failed';
  return {
    operationId: id,
    status,
    ...(typeof data.roomId === 'string' ? { roomId: data.roomId } : {}),
    ...(typeof data.messageId === 'string' ? { messageId: data.messageId } : {}),
    ...(typeof data.seq === 'number' ? { seq: data.seq } : {}),
    ...(typeof data.version === 'number' ? { version: data.version } : {}),
    ...(data.errorCode === 'screening-blocked' || data.errorCode === 'screening-unavailable'
      ? { errorCode: data.errorCode }
      : data.status !== 'complete' && data.status !== 'pending' && data.status !== 'cancelled' && data.status !== 'failed'
        ? { errorCode: 'screening-unavailable' as const } : {}),
  };
}

// All transaction reads (including authorization) must precede this helper.
// A missing, replaced, or already-settled claim is never recreated or overwritten.
export function settleSubmissionFailure(
  transaction: Transaction,
  submissionSnap: DocumentSnapshot,
  receiptSnap: DocumentSnapshot,
  callerUid: string,
  payloadHash: string,
  errorCode: ModerationErrorCode = 'screening-unavailable'
): CommandResult {
  if (receiptSnap.exists) {
    const receipt = receiptSnap.data()!;
    if (receipt.callerUid === callerUid && receipt.payloadHash === payloadHash) {
      return submissionReceiptResult(receipt, receiptSnap.id);
    }
    return { operationId: submissionSnap.id, status: 'failed', errorCode: 'screening-unavailable' };
  }
  const submission = submissionSnap.data();
  const result: CommandResult = {
    operationId: submissionSnap.id,
    status: 'failed',
    errorCode: 'screening-unavailable',
  };
  if (!submission || submission.callerUid !== callerUid || submission.payloadHash !== payloadHash ||
      submission.state !== 'pending' || typeof submission.roomId !== 'string' || !submission.roomId ||
      !['sendRoomMessage', 'editMessage', 'askThreadline', 'retryAiReply'].includes(submission.operation)) return result;
  const receipt = {
    operationId: submissionSnap.id,
    operation: submission.operation,
    callerUid,
    roomId: submission.roomId,
    payloadHash,
    status: 'failed',
    errorCode: isLiveSubmission(submission, callerUid, payloadHash) ? errorCode : 'screening-unavailable',
    ...(typeof submission.messageId === 'string' ? { messageId: submission.messageId } : {}),
    ...(typeof submission.generationId === 'string' ? { generationId: submission.generationId } : {}),
    createdAt: FieldValue.serverTimestamp(),
  };
  transaction.create(receiptSnap.ref, receipt);
  transaction.delete(submissionSnap.ref);
  return submissionReceiptResult(receipt, submissionSnap.id);
}

export const SCREENING_BLOCKED_MESSAGE = 'Message cannot be published as written. Please revise your text.';
export const SCREENING_UNAVAILABLE_MESSAGE = 'Content screening is currently unavailable. Please try again.';

export async function executeScreening(
  moderation: ModerationPort,
  text: string
): Promise<ModerationResult> {
  try {
    const result = await moderation.screen(text);
    if (!result || (result.verdict !== 'allow' && result.verdict !== 'block')) {
      return {
        verdict: 'unavailable',
        policyVersion: result?.policyVersion || MODERATION_POLICY_VERSION,
        reason: 'unknown-verdict',
      };
    }
    return result;
  } catch {
    return {
      verdict: 'unavailable',
      policyVersion: MODERATION_POLICY_VERSION,
      reason: 'moderation-exception',
    };
  }
}
