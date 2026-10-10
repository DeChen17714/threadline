import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { commandSchema, type CommandResult } from '@threadline/shared';
import { getDb } from './firebase.js';
import { allowedOrigins, isIsolatedEmulator, validateEnvironmentAndOrigin, requireAuthenticatedUser } from './utils/auth.js';
import { createSafeAppError } from './utils/errors.js';
import { logCommandEvent } from './utils/logging.js';
import { handleCreateRoom } from './handlers/createRoom.js';
import { handleSendRoomMessage } from './handlers/sendRoomMessage.js';
import { handleGetOperation } from './handlers/getOperation.js';
import { handleEditMessage, handleDeleteMessage } from './handlers/messageMutations.js';
import {
  handleIssueInvite,
  handleRevokeInvite,
  handleRequestJoin,
  handleGetJoinStatus,
  handleListJoinRequests,
  handleDecideJoin,
} from './handlers/invitations.js';
import {
  handleDeleteRoom,
  handleResumeMaintenance,
  handleListPendingOperations,
} from './handlers/maintenance.js';
import { handleAskThreadline, handleRetryAiReply } from './ai/lifecycle.js';
import { requireAiAccess, getServerAiPolicy } from './ai/policy.js';
import { createGeminiProvider } from './ai/provider.js';
import { handleRecoverGeneration } from './ai/recovery.js';
import { createOpenAiModerationPort } from './moderation/provider.js';

const geminiKey = defineSecret('GEMINI_API_KEY');
const openaiKey = defineSecret('OPENAI_API_KEY');
function assertHandled(value: never): never {
  void value;
  throw new HttpsError('internal', 'Unsupported operation');
}

export const command = onCall(
  {
    region: 'asia-southeast1',
    minInstances: 0,
    maxInstances: 2,
    concurrency: 8,
    timeoutSeconds: 120,
    secrets: [geminiKey, openaiKey],
    cors: allowedOrigins(),
    enforceAppCheck: !isIsolatedEmulator(),
    ...(process.env.FUNCTION_SERVICE_ACCOUNT ? { serviceAccount: process.env.FUNCTION_SERVICE_ACCOUNT } : {}),
  },
  async (request): Promise<CommandResult> => {
    const startTime = Date.now();
    let requestId: string | null = null;
    let operation: string | undefined;
    let callerUid: string | null = null;

    try {
      const data = request.data as Record<string, unknown> | null | undefined;
      requestId = typeof data?.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(data.requestId) ? data.requestId : null;

      // 1. Fail-closed origin and production App Check validation
      validateEnvironmentAndOrigin(request, requestId);

      // 2. Strict caller authentication
      const user = requireAuthenticatedUser(request, requestId);
      callerUid = user.uid;

      // 3. Strict schema validation (rejects unknown operations and extra fields)
      const parseResult = commandSchema.safeParse(data);
      if (!parseResult.success) {
        throw createSafeAppError('validation', 'Invalid command fields or operation.', requestId);
      }

      const validatedCommand = parseResult.data;
      operation = validatedCommand.operation;
      requestId = validatedCommand.requestId;
      logCommandEvent('info', 'Command received', {
        requestId,
        operation: validatedCommand.operation,
        uid: callerUid,
      });

      const db = getDb();
      const moderation = createOpenAiModerationPort(openaiKey.value());
      let result: CommandResult;
      switch (validatedCommand.operation) {
        case 'createRoom': {
          result = await handleCreateRoom(
            db,
            user.uid,
            user.label,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'sendRoomMessage': {
          result = await handleSendRoomMessage(
            db,
            user.uid,
            user.label,
            validatedCommand.requestId,
            validatedCommand.input,
            moderation
          );
          break;
        }
        case 'editMessage': {
          result = await handleEditMessage(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input,
            moderation
          );
          break;
        }
        case 'deleteMessage': {
          result = await handleDeleteMessage(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'askThreadline': {
          const policy = getServerAiPolicy();
          requireAiAccess(user.uid, validatedCommand.requestId, policy);
          result = await handleAskThreadline(
            db,
            user.uid,
            user.label,
            validatedCommand.requestId,
            validatedCommand.input,
            policy,
            createGeminiProvider(geminiKey.value()),
            moderation
          );
          break;
        }
        case 'retryAiReply': {
          const policy = getServerAiPolicy();
          requireAiAccess(user.uid, validatedCommand.requestId, policy);
          result = await handleRetryAiReply(
            db,
            user.uid,
            user.label,
            validatedCommand.requestId,
            validatedCommand.input,
            policy,
            createGeminiProvider(geminiKey.value()),
            moderation
          );
          break;
        }
        case 'recoverGeneration': {
          result = await handleRecoverGeneration(db, user.uid, validatedCommand.requestId, validatedCommand.input);
          break;
        }
        case 'getOperation': {
          result = await handleGetOperation(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'issueInvite': {
          result = await handleIssueInvite(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'revokeInvite': {
          result = await handleRevokeInvite(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'requestJoin': {
          result = await handleRequestJoin(
            db,
            user.uid,
            user.label,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'getJoinStatus': {
          result = await handleGetJoinStatus(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'listJoinRequests': {
          result = await handleListJoinRequests(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'decideJoin': {
          result = await handleDecideJoin(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'deleteRoom': {
          result = await handleDeleteRoom(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'resumeMaintenance': {
          result = await handleResumeMaintenance(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        case 'listPendingOperations': {
          result = await handleListPendingOperations(
            db,
            user.uid,
            validatedCommand.requestId,
            validatedCommand.input
          );
          break;
        }
        default: {
          assertHandled(validatedCommand);
        }
      }

      const durationMs = Date.now() - startTime;
      logCommandEvent('info', 'Command succeeded', {
        requestId,
        operation: validatedCommand.operation,
        uid: callerUid,
        status: result.status,
        durationMs,
      });

      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      if (err instanceof HttpsError) {
        const details = err.details as Record<string, unknown> | undefined;
        logCommandEvent('error', 'Command failed with HttpsError', {
          requestId,
          operation,
          uid: callerUid,
          errorCode: (details?.code as string | undefined) || err.code,
          durationMs,
        });
        throw err;
      }

      logCommandEvent('error', 'Command failed with unexpected error', {
        requestId,
        operation,
        uid: callerUid,
        errorCode: 'internal',
        durationMs,
      });
      throw createSafeAppError('provider-unavailable', 'The operation could not finish. Retry with the same request.', requestId);
    }
  }
);
