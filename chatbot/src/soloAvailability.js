'use strict';

// Availability gate for the solo-only credential skills. Mirrors the shape of
// planFirstAvailability. Pure + env-free so it is unit-testable. The whole
// capability is OFF unless SOLO_CREDENTIAL_MODE is explicitly enabled AND the
// runtime compiler beta is on AND an n8n API key is present. See
// a2a/skills/SOLO_CALENDAR_READ_DESIGN.md — multi-user stays blocked.
function soloAvailability({ soloMode, runtimeCompilerEnabled, apiKeyPresent } = {}) {
  if (!soloMode) {
    return { available: false, status: 404, error: 'Solo credential mode is disabled.' };
  }
  if (!runtimeCompilerEnabled) {
    return { available: false, status: 404, error: 'Runtime Compiler Beta is disabled.' };
  }
  if (!apiKeyPresent) {
    return { available: false, status: 503, error: 'Solo calendar skill requires an n8n API key.' };
  }
  return { available: true, status: 200, error: null };
}

module.exports = { soloAvailability };
