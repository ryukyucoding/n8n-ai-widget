'use strict';

/**
 * Hardened Credential Ownership Boundary Adapter (OVR-1 Repaired Pass 2)
 *
 * Implements a metadata-only credential boundary that represents authorized-owner
 * credential references without exposing secret values or admitting an administrator's
 * full inventory to planner/compiler context.
 *
 * Residual Fixes (Pass 2):
 * 1. Non-scalar ownerUserId rejection: If ownerUserId is present in entry, it MUST be a scalar string.
 *    Non-scalar types (arrays, objects, numbers, booleans) fail closed immediately with an error
 *    and NEVER fall back to entry.owner.
 * 2. Missing/unknown state rejection: The `state` property MUST be an explicit scalar string
 *    matching VALID_STATES ('active', 'inactive', 'revoked'). Missing state is strictly rejected
 *    (fails closed, never defaults to 'active').
 * 3. Trusted relation-resolved policy & provenance contract: The boundary enforces that
 *    authorizedOwnerId and provenance must match an immutable trusted-authority contract
 *    (TRUSTED_OWNERS_ALLOWLIST and TRUSTED_PROVENANCE_ALLOWLIST), rejecting caller-asserted arbitrary values.
 *
 * Security Invariants:
 * - Values excluded 100%: secret fields never enter boundary records or revision hashes.
 * - Credential name alone never proves ownership.
 * - Unknown, foreign, revoked, or ambiguous ownership strictly fails closed.
 * - Zero live n8n calls, zero .44 calls, zero network mutation.
 */

const crypto = require('node:crypto');

const TRUSTED_CANONICAL_OWNER_ID = 'daniel';
const TRUSTED_OWNERS_ALLOWLIST = new Set([
  'daniel',
  'dan',
  'dan0203',
]);

const TRUSTED_PROVENANCE_ALLOWLIST = new Set([
  'local_manifest',
  'audit_repair_harness',
  'phase2_runner',
  'offline_test',
]);

const VALID_STATES = new Set(['active', 'inactive', 'revoked']);

function isScalarString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

class CredentialOwnershipBoundary {
  constructor(options = {}) {
    // 3. Trusted relation-resolved authority contract
    const rawOwner = options.authorizedOwnerId;
    if (rawOwner !== undefined) {
      if (!isScalarString(rawOwner) || !TRUSTED_OWNERS_ALLOWLIST.has(rawOwner.trim().toLowerCase())) {
        this.boundaryValid = false;
        this.boundaryError = 'untrusted_authorized_owner_id';
        return;
      }
      this.authorizedOwnerId = rawOwner.trim().toLowerCase();
    } else {
      this.authorizedOwnerId = TRUSTED_CANONICAL_OWNER_ID;
    }

    const rawProv = options.provenance;
    if (rawProv !== undefined) {
      if (!isScalarString(rawProv) || !TRUSTED_PROVENANCE_ALLOWLIST.has(rawProv.trim())) {
        this.boundaryValid = false;
        this.boundaryError = 'untrusted_or_missing_provenance';
        return;
      }
      this.provenance = rawProv.trim();
    } else {
      this.provenance = 'local_manifest';
    }

    this.boundaryValid = true;
    this.boundaryError = null;
    this.recordsById = new Map();
    this.recordsByTypeAndName = new Map();
    this.manifestValid = false;
    this.manifestError = null;
    this.manifestRevision = '0000000000000000000000000000000000000000000000000000000000000000';

    if (options.manifestEntries !== undefined) {
      this.loadManifest(options.manifestEntries);
    }
  }

  isAuthorizedOwner(owner) {
    if (!isScalarString(owner)) return false;
    const normalized = owner.trim().toLowerCase();
    return TRUSTED_OWNERS_ALLOWLIST.has(normalized) && normalized === this.authorizedOwnerId;
  }

  /**
   * Load and sanitize credential manifest metadata.
   * Fails closed safely if manifest is malformed, contains duplicate IDs,
   * missing/invalid states, non-scalar owners, or duplicate (type, name) collisions.
   *
   * @param {Array<Object>} entries
   * @returns {Object} { valid: boolean, count: number, error?: string }
   */
  loadManifest(entries) {
    this.recordsById.clear();
    this.recordsByTypeAndName.clear();
    this.manifestValid = false;
    this.manifestError = null;
    this.manifestRevision = '0000000000000000000000000000000000000000000000000000000000000000';

    if (!this.boundaryValid) {
      this.manifestError = this.boundaryError;
      return { valid: false, count: 0, error: this.manifestError };
    }

    if (!Array.isArray(entries)) {
      this.manifestError = 'manifest_not_an_array';
      return { valid: false, count: 0, error: this.manifestError };
    }

    const seenIds = new Set();
    const seenTypeAndNames = new Set();
    const sanitizedList = [];

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        this.manifestError = `malformed_entry_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      const id = isScalarString(entry.id) ? entry.id.trim() : null;
      const credentialType = isScalarString(entry.type) ? entry.type.trim() : null;
      const name = isScalarString(entry.name) ? entry.name.trim() : (id || null);

      if (!id || !credentialType) {
        this.manifestError = `missing_id_or_type_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      // 1. Residual 1: Strict ownerUserId scalar validation
      let rawOwner = null;
      if ('ownerUserId' in entry) {
        if (!isScalarString(entry.ownerUserId)) {
          // Present but non-scalar -> fail closed, NEVER fall back to entry.owner
          this.manifestError = `non_scalar_owner_user_id_at_index_${i}`;
          return { valid: false, count: 0, error: this.manifestError };
        }
        rawOwner = entry.ownerUserId.trim();
      } else if ('owner' in entry) {
        if (!isScalarString(entry.owner)) {
          this.manifestError = `non_scalar_owner_at_index_${i}`;
          return { valid: false, count: 0, error: this.manifestError };
        }
        rawOwner = entry.owner.trim();
      }

      // 2. Residual 2: Strict state validation (missing or unknown state must reject)
      if (!('state' in entry) || !isScalarString(entry.state)) {
        this.manifestError = `missing_state_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      const state = entry.state.trim().toLowerCase();
      if (!VALID_STATES.has(state)) {
        this.manifestError = `invalid_state_at_index_${i}`;
        return { valid: false, count: 0, error: this.manifestError };
      }

      // Order-independent duplicate ID check
      if (seenIds.has(id)) {
        this.manifestError = 'duplicate_credential_id_collision';
        return { valid: false, count: 0, error: this.manifestError };
      }
      seenIds.add(id);

      // Order-independent duplicate (type, name) collision check
      const typeAndNameKey = `${credentialType}:${name}`;
      if (seenTypeAndNames.has(typeAndNameKey)) {
        this.manifestError = 'duplicate_type_and_name_collision';
        return { valid: false, count: 0, error: this.manifestError };
      }
      seenTypeAndNames.add(typeAndNameKey);

      // Ownership classification against trusted authority
      let ownershipClassification = 'unknown';
      if (rawOwner && this.isAuthorizedOwner(rawOwner)) {
        ownershipClassification = 'daniel_owned';
      } else if (rawOwner) {
        ownershipClassification = 'foreign_rejected';
      }

      // Record strictly sanitized metadata without secret fields
      const sanitizedRecord = {
        id,
        type: credentialType,
        name,
        ownerUserId: rawOwner || 'unspecified',
        ownership: ownershipClassification,
        state,
      };

      this.recordsById.set(id, sanitizedRecord);
      this.recordsByTypeAndName.set(typeAndNameKey, sanitizedRecord);
      sanitizedList.push(sanitizedRecord);
    }

    // Sort deterministically by ID for reproducible revision hashing
    sanitizedList.sort((a, b) => a.id.localeCompare(b.id));

    const manifestData = {
      authorizedOwnerId: this.authorizedOwnerId,
      provenance: this.provenance,
      records: sanitizedList,
    };

    this.manifestRevision = crypto.createHash('sha256').update(JSON.stringify(manifestData)).digest('hex');
    this.manifestValid = true;
    return { valid: true, count: sanitizedList.length };
  }

  /**
   * Resolve a requested credential reference or requirement against authorized inventory.
   *
   * @param {Object} query
   * @param {string} query.type - Required credential type (e.g. 'googleCalendarOAuth2')
   * @param {string} [query.id] - Specific credential ID
   * @param {string} [query.name] - Credential name
   * @returns {Object} Sanitized capability report
   */
  resolveCredentialRequirement(query = {}) {
    if (!this.boundaryValid) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: this.boundaryError,
        manifestRevision: this.manifestRevision,
      };
    }

    if (!this.manifestValid) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: this.manifestError || 'manifest_invalid_or_unloaded',
        manifestRevision: this.manifestRevision,
      };
    }

    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'invalid_query_object',
        manifestRevision: this.manifestRevision,
      };
    }

    const type = isScalarString(query.type) ? query.type.trim() : '';
    const id = isScalarString(query.id) ? query.id.trim() : '';
    const name = isScalarString(query.name) ? query.name.trim() : '';

    if (!type) {
      return {
        status: 'unavailable',
        allowed: false,
        reason: 'missing_credential_type',
        manifestRevision: this.manifestRevision,
      };
    }

    let record = null;

    if (id) {
      // Exact type + ID binding check
      const candidate = this.recordsById.get(id);
      if (candidate) {
        if (candidate.type !== type) {
          return {
            status: 'unavailable',
            allowed: false,
            type,
            reason: 'credential_type_mismatch_for_id',
            manifestRevision: this.manifestRevision,
          };
        }
        record = candidate;
      }
    } else if (name) {
      const typeAndNameKey = `${type}:${name}`;
      record = this.recordsByTypeAndName.get(typeAndNameKey) || null;
    } else {
      // Find single candidate by type
      const matching = Array.from(this.recordsById.values()).filter((r) => r.type === type);
      if (matching.length === 1) {
        record = matching[0];
      } else if (matching.length > 1) {
        return {
          status: 'unavailable',
          allowed: false,
          type,
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

    // Foreign rejection: never leak the foreign opaque ID
    if (record.ownership === 'foreign_rejected') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: 'foreign_owner_rejected',
        manifestRevision: this.manifestRevision,
      };
    }

    // Ambiguous or missing owner
    if (record.ownership !== 'daniel_owned') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: 'ambiguous_or_unverified_ownership',
        manifestRevision: this.manifestRevision,
      };
    }

    // State enforcement: only active state may resolve as available_now
    if (record.state !== 'active') {
      return {
        status: 'unavailable',
        allowed: false,
        type: record.type,
        reason: `credential_state_${record.state}`,
        manifestRevision: this.manifestRevision,
      };
    }

    // Authorized, active, Daniel-owned resolution
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
  TRUSTED_CANONICAL_OWNER_ID,
  TRUSTED_OWNERS_ALLOWLIST,
  TRUSTED_PROVENANCE_ALLOWLIST,
  isScalarString,
  CredentialOwnershipBoundary,
};
