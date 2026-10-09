import type { DocumentData } from 'firebase-admin/firestore';
import { MODEL } from './provider.js';
import { createSafeAppError } from '../utils/errors.js';
import { isIsolatedEmulator } from '../utils/auth.js';

export const BUDGET_ID = 'threadline';
export const RESERVATION_MICRO_USD = 30000;
export const PRICING_EXPIRY = Date.UTC(2027, 0, 1);
export const HOSTED_ALLOWANCE_MYR = 20;
export const HOSTED_ATTEMPT_LIMIT = 50;
export const LEGACY_LOCAL_ATTEMPT_LIMIT = 50;

export interface AiPolicy {
  readonly testerUids: readonly string[];
  readonly localDevelopment?: boolean;
  readonly now?: () => number;
}

export interface HostedConversionMetadata {
  readonly sources: readonly string[];
  readonly reviewedAt: number;
  readonly expiresAt: number;
  readonly rateMicroMyrPerUsd: number;
  readonly headroomBps: number;
  readonly remainingFundsMicroMyr: number;
  readonly alreadyConsumedMicroUsd: number;
}

export function getServerAiPolicy(): AiPolicy {
  return {
    testerUids: (process.env.AI_TESTER_UIDS ?? '')
      .split(',')
      .map(uid => uid.trim())
      .filter(Boolean),
    localDevelopment: isIsolatedEmulator(),
  };
}

export function requireAiAccess(uid: string, requestId: string, policy: AiPolicy): void {
  if (!policy.localDevelopment && !policy.testerUids.includes(uid)) {
    throw createSafeAppError('forbidden', 'Hosted AI is available only to approved reviewer accounts.', requestId);
  }
}

export function calculateHostedAllowanceCapMicroUsd(conversion: HostedConversionMetadata): number {
  const { rateMicroMyrPerUsd, headroomBps, remainingFundsMicroMyr, alreadyConsumedMicroUsd } = conversion;

  if (!Number.isSafeInteger(rateMicroMyrPerUsd) || rateMicroMyrPerUsd <= 0) {
    throw new Error('Invalid rateMicroMyrPerUsd');
  }
  if (!Number.isSafeInteger(headroomBps) || headroomBps <= 0) {
    throw new Error('Invalid headroomBps');
  }
  if (!Number.isSafeInteger(remainingFundsMicroMyr) || remainingFundsMicroMyr < 0) {
    throw new Error('Invalid remainingFundsMicroMyr');
  }
  if (!Number.isSafeInteger(alreadyConsumedMicroUsd) || alreadyConsumedMicroUsd < 0) {
    throw new Error('Invalid alreadyConsumedMicroUsd');
  }

  const rate = BigInt(rateMicroMyrPerUsd);
  const num = rate * (10_000n + BigInt(headroomBps));

  const convertMyrToMicroUsd = (microMyr: bigint): bigint => {
    return (microMyr * 10_000n * 1_000_000n) / num;
  };

  const rm20Cap = convertMyrToMicroUsd(BigInt(HOSTED_ALLOWANCE_MYR) * 1_000_000n);
  const availableCap = convertMyrToMicroUsd(BigInt(remainingFundsMicroMyr)) + BigInt(alreadyConsumedMicroUsd);

  const maxAllowedBigInt = rm20Cap < availableCap ? rm20Cap : availableCap;
  if (maxAllowedBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Calculated allowance exceeds safe integer range');
  }

  return Number(maxAllowedBigInt);
}

export function getAttemptLimit(budget: DocumentData, policy: AiPolicy): number | null {
  if (policy.localDevelopment) {
    if (budget.localAttemptLimit === null) {
      return null;
    }
    if (budget.localAttemptLimit === undefined) {
      return LEGACY_LOCAL_ATTEMPT_LIMIT;
    }
    if (Number.isSafeInteger(budget.localAttemptLimit) && budget.localAttemptLimit >= 0) {
      return budget.localAttemptLimit;
    }
    return 0;
  }
  return HOSTED_ATTEMPT_LIMIT;
}

export function checkPricing(
  budget: DocumentData | undefined,
  now: number,
  requestId: string,
  policy: AiPolicy
): asserts budget is DocumentData {
  if (!budget) {
    throw createSafeAppError('provider-unavailable', 'AI configuration is not qualified or its pricing approval expired.', requestId);
  }

  if (
    budget.model !== MODEL ||
    budget.qualified !== true ||
    budget.paidServicesVerified !== true ||
    budget.safetyPolicy !== 'medium-and-above-v1' ||
    budget.reservationMicroUsd !== RESERVATION_MICRO_USD ||
    !Number.isSafeInteger(budget.pricingExpiresAt) ||
    budget.pricingExpiresAt <= now ||
    budget.pricingExpiresAt > PRICING_EXPIRY ||
    !Number.isSafeInteger(budget.consumedMicroUsd) ||
    budget.consumedMicroUsd < 0 ||
    !Number.isSafeInteger(budget.reservedMicroUsd) ||
    budget.reservedMicroUsd < 0
  ) {
    throw createSafeAppError('provider-unavailable', 'AI configuration is not qualified or its pricing approval expired.', requestId);
  }

  if (policy.localDevelopment === true) {
    const validAllowance =
      budget.allowanceMicroUsd === null ||
      (Number.isSafeInteger(budget.allowanceMicroUsd) && budget.allowanceMicroUsd >= 0);

    const validAttemptLimit =
      budget.localAttemptLimit === null ||
      budget.localAttemptLimit === undefined ||
      (Number.isSafeInteger(budget.localAttemptLimit) && budget.localAttemptLimit >= 0);

    if (!validAllowance || !validAttemptLimit) {
      throw createSafeAppError('provider-unavailable', 'AI configuration is not qualified or its pricing approval expired.', requestId);
    }
  } else {
    if (!Number.isSafeInteger(budget.allowanceMicroUsd) || budget.allowanceMicroUsd < 0) {
      throw createSafeAppError('provider-unavailable', 'Hosted AI requires a valid numeric allowance in microUSD.', requestId);
    }

    const conversion = budget.conversion as HostedConversionMetadata | undefined;
    if (!conversion || typeof conversion !== 'object') {
      throw createSafeAppError('provider-unavailable', 'Hosted AI requires reviewed RM20 conversion metadata.', requestId);
    }

    if (
      !Array.isArray(conversion.sources) ||
      conversion.sources.length === 0 ||
      conversion.sources.some(s => typeof s !== 'string' || !s.trim())
    ) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion metadata missing reviewed sources.', requestId);
    }

    if (!Number.isSafeInteger(conversion.reviewedAt) || conversion.reviewedAt <= 0 || conversion.reviewedAt > now) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion review timestamp is invalid or from the future.', requestId);
    }

    if (
      !Number.isSafeInteger(conversion.expiresAt) ||
      conversion.expiresAt <= now ||
      conversion.expiresAt > PRICING_EXPIRY ||
      conversion.expiresAt > budget.pricingExpiresAt
    ) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion review has expired or exceeds pricing approval.', requestId);
    }

    if (
      !Number.isSafeInteger(conversion.rateMicroMyrPerUsd) ||
      conversion.rateMicroMyrPerUsd <= 0
    ) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion exchange rate is invalid.', requestId);
    }

    if (!Number.isSafeInteger(conversion.headroomBps) || conversion.headroomBps <= 0) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion headroom is invalid.', requestId);
    }

    if (!Number.isSafeInteger(conversion.remainingFundsMicroMyr) || conversion.remainingFundsMicroMyr < 0) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion remaining funds invalid.', requestId);
    }

    if (
      !Number.isSafeInteger(conversion.alreadyConsumedMicroUsd) ||
      conversion.alreadyConsumedMicroUsd < 0 ||
      conversion.alreadyConsumedMicroUsd > budget.consumedMicroUsd
    ) {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion baseline exceeds current consumed ledger.', requestId);
    }

    let maxAllowedMicroUsd: number;
    try {
      maxAllowedMicroUsd = calculateHostedAllowanceCapMicroUsd(conversion);
    } catch {
      throw createSafeAppError('provider-unavailable', 'Hosted conversion calculation failed.', requestId);
    }

    if (budget.allowanceMicroUsd > maxAllowedMicroUsd) {
      throw createSafeAppError('provider-unavailable', 'Hosted allowance exceeds reviewed conservative RM20 ceiling.', requestId);
    }
  }
}
