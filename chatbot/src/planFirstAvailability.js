'use strict';

const MIN_PLANNER_APPROVAL_SECRET_LENGTH = 32;

function enabledEnvironmentValue(value) {
  return ['1', 'true', 'yes'].includes(String(value || 'false').toLowerCase());
}

function planFirstAvailability({ runtimeCompilerEnabled, planFirstEnabled, secret }) {
  if (!planFirstEnabled) {
    return { available: false, status: 404, error: 'Plan-first compiler is disabled.' };
  }
  if (!runtimeCompilerEnabled) {
    return { available: false, status: 404, error: 'Runtime Compiler Beta is disabled.' };
  }
  if (typeof secret !== 'string' || secret.length < MIN_PLANNER_APPROVAL_SECRET_LENGTH) {
    return {
      available: false,
      status: 503,
      error: `Plan review is not configured: PLANNER_APPROVAL_HMAC_SECRET must be at least ${MIN_PLANNER_APPROVAL_SECRET_LENGTH} characters.`,
    };
  }
  return { available: true, status: 200, error: null };
}

module.exports = {
  MIN_PLANNER_APPROVAL_SECRET_LENGTH,
  enabledEnvironmentValue,
  planFirstAvailability,
};
