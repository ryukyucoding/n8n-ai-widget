'use strict';

/**
 * Isolated Credential Capability Boundary Adapter (OVR-1 Milestone)
 *
 * Implements a metadata-only credential boundary that represents Daniel-owned
 * credential references without exposing secret values or admitting an administrator's
 * full inventory to planner/compiler context.
 *
 * Security Invariants:
 * 1. Values are completely excluded: only opaque references (e.g. "cred-dan-xxx") and types are processed.
 * 2. Credential name alone never proves ownership; explicit ownerUserId matching is required.
 * 3. Unknown, missing, or ambiguous ownership strictly fails closed (ownership: 'unknown' / 'foreign_rejected').
 * 4. Non-Daniel records are rejected from the candidate allowlist.
 * 5. Classifies status as available_now, needs_setup, or unavailable.
 * 6. Manifest fingerprinting hashes only structural metadata, never secret values.
 * 7. Zero live n8n network calls required; 100% offline pure adapter.
 */

const crypto = require('node:crypto');

const AUTHORIZED_OWNER_ID = 'daniel';
const AUTHORIZED_OWNER_PATTERNS = [
  /^daniel$/i,
  /^dan$/i,
  /^dan0203$/i,
];

function isDanielOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim()) return false;
  const s = owner.trim();
  return AUTHORIZED_OWNER_PATTERNS.some((p) => p.test(s));
}

class CredentialOwnershipBoundary {
  constructor(options = {}) {
    this.authorizedOwnerId = options.authorizedOwnerId || AUTHORIZED_OWNER_ID;
    this.recordsById = new Map();
    this.recordsByTypeAndName = new Map();
    this.manifestRevision = '0000000000000000000000000000000000000000000000000000000000000000';
    if (options.manifestEntries) {
      this.loadManifest(options.manifestEntries);
    }
  }

  /**
   * Load sanitized credential manifest metadata.
   * Strips any accidental secret fields (passwords, tokens, keys) immediately.
   *
   * @param {Array<Object>} entries
   */
  loadManifest(entries = []) {
    this.recordsById.clear();
    this.recordsByTypeAndName.clear();
    const sanitizedList = [];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

      // Extract only structural, metadata-safe fields
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const credentialType = typeof entry.type === 'string' ? entry.type.trim() : '';
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const ownerUserId = typeof entry.ownerUserId === 'string' ? entry.ownerUserId.trim() : (entry.owner || '');
      const state = typeof entry.state === 'string' ? entry.state.trim() : 'active';

      if (!id || !credentialType) continue;

      // Classify ownership strictly
      let ownershipClassification = 'unknown';
      if (isDanielOwner(ownerUserId)) {
        ownershipClassification = 'daniel_owned';
      } else if (ownerUserId) {
        ownershipClassification = 'foreign_rejected';
      }

      const sanitizedRecord = {
        id,
        type: credentialType,
        name: name || id,
        ownerUserId: ownerUserId || 'unspecified',
        ownership: ownershipClassification,
        state,
      };

      this.recordsById.set(id, sanitizedRecord);
      this.recordsByTypeAndName.set(`${credentialType}:${sanitizedRecord.name}`, sanitizedRecord);
      sanitizedList.push(sanitizedRecord);
    }

    // Compute manifest revision hash over sanitized records
    const str = JSON.stringify(sanitizedList.sort((a, b) => a.id.localeCompare(b.id)));
    this.manifestRevision = crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Evaluate a requested credential reference or requirement against Daniel-owned inventory.
   *
   * @param {Object} query
   * @param {string} query.type - Required credential type (e.g. 'googleCalendarOAuth2')
   * @param {string} [query.id] - Specific credential ID
   * @param {string} [query.name] - Credential name
   * @returns {Object} Sanitized capability report
   */
  resolveCredentialRequirement(query = {}) {
    if (!query || typeof query !== 'object') {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'invalid_query',
        manifestRevision: this.manifestRevision,
      };
    }

    const type = typeof query.type === 'string' ? query.type.trim() : '';
    const id = typeof query.id === 'string' ? query.id.trim() : '';
    const name = typeof query.name === 'string' ? query.name.trim() : '';

    if (!type) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'missing_credential_type',
        manifestRevision: this.manifestRevision,
      };
    }

    let record = null;
    if (id && this.recordsById.has(id)) {
      record = this.recordsById.get(id);
    } else if (name && this.recordsByTypeAndName.has(`${type}:${name}`)) {
      record = this.recordsByTypeAndName.get(`${type}:${name}`);
    } else {
      // Find candidate by type
      const matching = Array.from(this.recordsById.values()).filter((r) => r.type === type);
      if (matching.length === 1) {
        record = matching[0];
      } else if (matching.length > 1) {
        // Ambiguous ownership or multiple candidates fail closed
        return {
          status: 'unavailable',
          allowed: false,
          reason: 'ambiguous_multiple_credentials',
          candidateCount: matching.length,
          manifestRevision: this.manifestRevision,
        };
      }
    }

    if (!record) {
      return {
        status: 'needs_setup',
        allowed: false,
        type,
        reason: 'credential_not_found',
        manifestRevision: this.manifestRevision,
      };
    }

    // Strict ownership enforcement
    if (record.ownership === 'foreign_rejected') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        opaqueId: record.id,
        reason: 'foreign_owner_rejected',
        manifestRevision: this.manifestRevision,
      };
    }

    if (record.ownership !== 'daniel_owned') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: 'ambiguous_or_unverified_ownership',
        manifestRevision: this.manifestRevision,
      };
    }

    // Daniel-owned verified
    return {
      status: 'available_now',
      allowed: true,
      opaqueRef: {
        id: record.id,
        type: record.type,
        name: record.name,
      },
      ownership: 'daniel_owned',
      manifestRevision: this.manifestRevision,
    };
  }

  getRevision() {
    return this.manifestRevision;
  }
}

module.exports = {
  AUTHORIZED_OWNER_ID,
  isDanielOwner,
  CredentialOwnershipBoundary,
};
