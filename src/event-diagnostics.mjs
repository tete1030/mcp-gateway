import { randomUUID } from 'node:crypto';
import { callbackErrorCategory, CALLBACK_ERROR_CATEGORIES } from './callback.mjs';

const phases = new Set(['subscribe_received', 'params_validated', 'authorized', 'destination_validated',
  'state_reserved', 'challenge_started', 'challenge_response', 'challenge_verified', 'challenge_cached',
  'challenge_failed', 'state_committing', 'state_committed', 'subscribe_complete', 'subscribe_failed',
  'unsubscribe_received', 'unsubscribe_complete', 'unsubscribe_failed']);
const categories = new Set([...CALLBACK_ERROR_CATEGORIES, 'params_rejected', 'permission_denied',
  'challenge_failed', 'subscription_changed', 'storage_error', 'protocol_error']);

export function subscriptionErrorCategory(error) {
  if (error?.name === 'ZodError' || error?.code === -32602) return 'params_rejected';
  if (error?.code === -32001) return 'permission_denied';
  if (error?.code === -32015) return error.data?.reason === 'subscription_changed' ? 'subscription_changed' : 'challenge_failed';
  return callbackErrorCategory(error);
}

// Five fixed fields. Temporary callback hostname capture has been retired.
// IDs are random and unrelated to owners, callback paths or keys.
export function createSubscriptionDiagnostic(sink) {
  const correlationId = randomUUID(), started = performance.now();
  return (phase, { httpStatus = null, errorCategory = null } = {}) => {
    if (!sink || !phases.has(phase)) return;
    const record = { correlationId, phase,
      httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
      errorCategory: categories.has(errorCategory) ? errorCategory : null,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)) };
    try { sink(record); } catch { /* Diagnostics are best effort. Never log the thrown error. */ }
  };
}
