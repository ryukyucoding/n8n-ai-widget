'use strict';

const { evaluateCredentialAccess } = require('./credentialModeGate');
const { resolveCredentialRequirements } = require('./credentialResolutionAdapter');
const { buildSetupManifest } = require('./setupManifest');

// Stage-3b dependency adapters that bind the conversation controller to the real
// nodewise planner/compiler — kept as small, testable factories. The credential
// resolver here is an explicit STUB (setup_required) until the target n8n
// credentials API is verified (no invented probe/bind endpoint, no real credential).

const EN_DIRECTIVE = /(\b(in\s+english|use\s+english|respond\s+in\s+english)\b)|(請?用英文|以英文|使用英文|用英語|以英語)/i;
const ZH_DIRECTIVE = /(\b(in\s+chinese|use\s+chinese|respond\s+in\s+chinese)\b)|(請?用中文|以中文|使用中文|用繁中|以繁中)/i;

// Deterministic language detector:
// 1. Explicit language directive takes absolute precedence (e.g. '請用英文' -> 'en', 'respond in Chinese' -> 'zh').
// 2. Script detection: presence of CJK characters -> 'zh', otherwise 'en'.
function detectLanguage(text) {
  const str = String(text || '').trim();
  if (!str) return 'en';
  if (EN_DIRECTIVE.test(str)) return 'en';
  if (ZH_DIRECTIVE.test(str)) return 'zh';
  return /[一-龥]/.test(str) ? 'zh' : 'en';
}

const REFINEMENT_PREFIX_ZH = /^(改成|加上|設為|移除|調整|只留)/;

// Refinement delta identifier:
// 1. Explicit refinement markers ('改成', '加上', '設為', '移除', '調整', '只留') are ALWAYS deltas.
// 2. Short operation phrases ('排序...', '限制...', '改名...', 'sort...', 'limit...') are treated as deltas
//    ONLY when in a refinement context (isRefinementContext = true, i.e. previousSpec exists).
//    On a fresh conversation (turn 1), a valid request like '排序 todos' or '限制取前5筆' is a legitimate macro goal!
function isDeltaInstruction(str, isRefinementContext = false) {
  const s = String(str || '').trim();
  if (s.length === 0 || s.length >= 25) return false;
  if (REFINEMENT_PREFIX_ZH.test(s)) return true;
  if (isRefinementContext) {
    if (/^(排序|限制|改名)/.test(s)) return true;
    if (/^(sort|order|change|set|remove|limit|descending|ascending)\b/i.test(s)) return true;
  }
  return false;
}

// Effective conversation language resolver:
// 1. Explicit language directive takes absolute precedence ('請用英文' -> 'en', 'respond in Chinese' -> 'zh').
// 2. Short delta refinements (e.g. 'sort descending' or '改成降序') preserve the conversation base language
//    from previousSpec rather than abruptly flipping the whole conversation language on a 2-word delta.
// 3. Otherwise, detect language from script (presence of CJK characters -> 'zh', else 'en').
function resolveEffectiveLanguage(message, previousSpec) {
  const str = String(message || '').trim();
  if (!str) return 'en';
  if (EN_DIRECTIVE.test(str)) return 'en';
  if (ZH_DIRECTIVE.test(str)) return 'zh';

  const isRefinement = Boolean(previousSpec && previousSpec.goal);
  const isShortDelta = isDeltaInstruction(str, isRefinement);
  if (isRefinement && isShortDelta) {
    return isLanguageMatch(previousSpec.goal, 'zh') ? 'zh' : 'en';
  }

  return /[一-龥]/.test(str) ? 'zh' : 'en';
}

const OBVIOUS_SIMPLIFIED_MARKERS = /数据|字段|依据|信息|列表|简体|请提供|更多信息/;

// Symmetric language matcher: verifies human-facing text matches target language.
// CJK presence alone accepts Simplified Chinese, so reject a small set of
// unambiguous Simplified markers before accepting Chinese human-facing prose.
function isLanguageMatch(text, lang) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const hasCJK = /[一-龥]/.test(text);
  if (lang === 'zh') return hasCJK && !OBVIOUS_SIMPLIFIED_MARKERS.test(text);
  return !hasCJK;
}

const TEMPLATES = {
  zh: {
    clarificationNeeds: (needs) => `需要更多資訊：${needs.join('、')}`,
    clarificationGoal: (goal) => `請補充：${goal}`,
    clarificationDefault: '請提供更明確的需求。',
    unsupported: (gaps) => `目前不支援此需求${gaps ? `：${gaps}` : ''}。系統只用已驗證的技能組合，不會硬生一個跑不動的 workflow。`,
    separator: '、',
    ready: (goal, steps) => `已規劃：${goal}（${steps} 步）。確認即可建立，或繼續告訴我要調整的地方。`,
    defaultGoal: '依需求規劃的工作流',
  },
  en: {
    clarificationNeeds: (needs) => `More information needed: ${needs.join(', ')}`,
    clarificationGoal: (goal) => `Please clarify: ${goal}`,
    clarificationDefault: 'Please provide more specific requirements.',
    unsupported: (gaps) => `This requirement is currently not supported${gaps ? `: ${gaps}` : ''}. The system only uses verified skill combinations and will not generate a broken workflow.`,
    separator: ', ',
    ready: (goal, steps) => `Planned: ${goal} (${steps} steps). Confirm to create, or tell me what to adjust.`,
    defaultGoal: 'Planned workflow according to request',
  },
};

// Resolve fallback goal when model goal drifts from caller language or language switches.
// If this is a refinement, preserve the previous canonical macro goal rather than
// clobbering it with a short delta command (e.g. 「改成降序」 or "sort descending").
function resolveFallbackGoal(message, previousSpec, lang, defaultGoal) {
  const isRefinement = Boolean(previousSpec && previousSpec.goal);
  const cleanMsg = typeof message === 'string' ? message.trim() : '';
  const isMsgDelta = isDeltaInstruction(cleanMsg, isRefinement);

  if (isRefinement) {
    // Short delta commands never replace the macro goal
    if (isMsgDelta) {
      return previousSpec.goal;
    }
    // If previous goal already matches target language, keep it
    if (isLanguageMatch(previousSpec.goal, lang)) {
      return previousSpec.goal;
    }
  }

  // On a fresh conversation, a valid non-refinement request (like '排序 todos') becomes the macro goal!
  if (isLanguageMatch(cleanMsg, lang) && cleanMsg.length >= 2 && !isMsgDelta) {
    return cleanMsg;
  }
  return isRefinement ? previousSpec.goal : defaultGoal;
}

const DOTTED_SKILL_ID_REGEX = /^[a-z][a-z0-9_]{0,30}\.[a-z0-9_.-]{1,40}$/i;
const SUSPICIOUS_TOKEN_REGEX = /\b(sk-[A-Za-z0-9_-]{3,}|bearer\s+[A-Za-z0-9._-]{3,}|ghp_[A-Za-z0-9_-]{3,}|glpat-[A-Za-z0-9_-]{3,}|xoxb-[A-Za-z0-9_-]{3,}|xoxp-[A-Za-z0-9_-]{3,})\b|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}|\b[A-Fa-f0-9]{32,}\b/i;

// Format capability gaps: preserve ONLY verified dotted skill identifiers (e.g. 'delivery.telegram')
// and caller-matching human prose, while strictly dropping secret-like tokens, un-dotted non-prose tokens,
// and mismatched prose.
function formatCapabilityGaps(gaps, lang, separator) {
  if (!Array.isArray(gaps) || gaps.length === 0) return '';
  const filtered = gaps.map((gap) => {
    if (typeof gap !== 'string') return '';
    const trimmed = gap.trim();
    if (!trimmed) return '';
    // Secret / token pattern protection: never preserve any token shaped like an API key or credential
    if (SUSPICIOUS_TOKEN_REGEX.test(trimmed)) return '';
    // Strictly require dotted skill-id grammar for technical identifiers
    if (DOTTED_SKILL_ID_REGEX.test(trimmed)) return trimmed;
    // Human-facing prose: CJK characters for Chinese, whitespace-separated words for English.
    // Drops single un-dotted tokens that are neither valid skill IDs nor natural prose.
    const isHumanProse = lang === 'zh' ? /[一-龥]/.test(trimmed) : /\s/.test(trimmed);
    if (isHumanProse && isLanguageMatch(trimmed, lang)) {
      return trimmed;
    }
    return '';
  }).filter(Boolean);
  return filtered.join(separator);
}

// Map a reviewNodewisePlannerResult envelope to the controller's plan contract:
// { outcome, spec, assistantMessage }. `reviewFromMessage(message, previousSpec)`
// runs the live nodewise planner + review (injected).
function createPlannerAdapter(reviewFromMessage) {
  return async function plan({ message, previousSpec }) {
    const lang = resolveEffectiveLanguage(message, previousSpec);
    const t = TEMPLATES[lang];
    const review = await reviewFromMessage(message, previousSpec);

    if (!review || review.outcome === 'clarification_required') {
      const rawNeeds = (review && review.requiredUserInputs) || [];
      const rawGoal = review && review.goal;
      // Symmetric language verification: drop inputs that mismatch caller language
      const matchedNeeds = rawNeeds.filter((need) => isLanguageMatch(need, lang));
      const matchedGoal = isLanguageMatch(rawGoal, lang) ? rawGoal : null;

      let messageContent;
      if (matchedNeeds.length > 0) {
        messageContent = t.clarificationNeeds(matchedNeeds);
      } else if (matchedGoal) {
        messageContent = t.clarificationGoal(matchedGoal);
      } else {
        messageContent = t.clarificationDefault;
      }

      return {
        outcome: 'clarification_required',
        spec: null,
        assistantMessage: messageContent,
      };
    }

    if (review.outcome === 'unsupported_capability') {
      const gaps = formatCapabilityGaps(review.capabilityGaps, lang, t.separator);
      return {
        outcome: 'unsupported_capability',
        spec: null,
        assistantMessage: t.unsupported(gaps),
      };
    }

    // ready_to_compile
    const spec = review.specification || null;
    const steps = ((review.plan && review.plan.steps) || (spec && spec.steps) || []).length;
    let goal = (review.plan && review.plan.goal) || (spec && spec.goal) || '';

    // If model goal is a short delta (e.g. "sort descending", "改成降序"), NEVER use it as macro goal
    const isRefinement = Boolean(previousSpec && previousSpec.goal);
    const isGoalDelta = isDeltaInstruction(goal, isRefinement);

    // Symmetric language verification: if model goal mismatches caller language or is a delta,
    // safely localize using previous canonical goal (for refinement) or scrubbed message/default.
    // Update spec.goal so the canonical spec matches the presentation goal without drift.
    if (!isLanguageMatch(goal, lang) || isGoalDelta) {
      goal = resolveFallbackGoal(message, previousSpec, lang, t.defaultGoal);
      if (spec) spec.goal = goal;
      if (review.plan) review.plan.goal = goal;
    }

    return {
      outcome: 'ready_to_compile',
      spec,
      assistantMessage: t.ready(goal, steps),
    };
  };
}

// Dependency-injected fake-only credential path. It is intentionally not wired
// into index.js: callers must provide trusted server-side policy and caller scope.
// The resolver adds a sanitized setupManifest for the controller/public view while
// keeping candidate handles in the server-side resolution only.
function createFakeCredentialResolver({
  policy = {},
  requiredTypesForSpec,
  listCandidates,
  callerId,
  scope = null,
} = {}) {
  if (typeof requiredTypesForSpec !== 'function' || typeof listCandidates !== 'function') {
    throw new Error('createFakeCredentialResolver requires requiredTypesForSpec and listCandidates');
  }
  return async function resolveCredentials(spec) {
    const requiredTypes = [...new Set((requiredTypesForSpec(spec) || []).filter((type) => typeof type === 'string' && type.trim()))];
    const gate = evaluateCredentialAccess(policy);
    if (!gate.allowed) {
      const requirements = requiredTypes.map((credentialType) => ({
        credentialType, status: 'unauthenticated', selected: null,
      }));
      return {
        requirements,
        overall: 'unauthenticated',
        createDisposition: 'review_only',
        setupManifest: buildSetupManifest({ requirements }),
        gate,
      };
    }
    const resolution = await resolveCredentialRequirements(
      requiredTypes,
      (credentialType) => listCandidates(credentialType, { callerId, scope }),
    );
    const manifestRequirements = resolution.requirements.map((requirement) => {
      const selected = requirement.candidates && requirement.candidates.find((candidate) => candidate.handle === requirement.selected);
      return {
        credentialType: requirement.credentialType,
        status: requirement.status,
        candidateCount: requirement.count,
        selectedDisplayName: selected && selected.displayName,
      };
    });
    return {
      ...resolution,
      setupManifest: buildSetupManifest({ requirements: manifestRequirements }),
      gate,
    };
  };
}

// STUB credential resolver: derives required credential TYPES from the spec via the
// injected `requiredTypesForSpec` (currently no credentialed nodewise skill, so it
// returns []), and reports setup_required for any type — it does NOT probe n8n or
// auto-bind. Replaced in stage-4 by the real resolver once the n8n credentials API
// (candidate listing + ownership) is verified. Named to make the stub obvious.
function createSetupRequiredResolver(requiredTypesForSpec) {
  return async function resolveCredentials(spec) {
    const types = (requiredTypesForSpec(spec) || []).filter((t) => typeof t === 'string');
    if (types.length === 0) {
      return { requirements: [], overall: 'ready', createDisposition: 'bind_and_create' };
    }
    return {
      requirements: types.map((t) => ({ credentialType: t, status: 'setup_required', selected: null })),
      overall: 'setup_required',
      createDisposition: 'create_inactive_draft',
    };
  };
}

// Confirm must go through the HMAC approval gate, never raw compile+create. This
// composes approveNodewisePlan (issues a token bound to spec + runtime/skill/source
// revisions + sessionId) -> compileApprovedNodewisePlan (re-verifies that binding;
// any spec/revision mutation fails the fingerprint) -> create. `sessionId` binds the
// approval to the conversation so a token can't be replayed across conversations.
function createConversationCompileAndCreate({ approve, compileApproved, createWorkflow, secret }) {
  if (typeof approve !== 'function' || typeof compileApproved !== 'function' || typeof createWorkflow !== 'function') {
    throw new Error('createConversationCompileAndCreate requires approve, compileApproved, createWorkflow');
  }
  return async function compileAndCreate(spec, resolution, ctx) {
    // STAGE-4 GAP (fail-closed): credential binding (resolution.requirements) is NOT
    // yet folded into the approval context or passed to create/bind. Until stage-4
    // wires bind-by-name + approval-context inclusion, REFUSE any spec that actually
    // requires a credential — the UI must never claim binding readiness while this
    // composer ignores it. The current resolver stub returns no requirements, so this
    // never trips on the public no-credential flow.
    if (resolution && Array.isArray(resolution.requirements) && resolution.requirements.length > 0) {
      throw new Error('credential binding not yet supported in conversation confirm (stage-4)');
    }
    const sessionId = (ctx && ctx.conversationId) || '';
    const approved = approve(spec, { secret, sessionId }); // -> { approvalToken, ... }
    // Re-verifies the token against THIS exact spec + current revisions; throws on mismatch.
    const compiled = compileApproved(spec, approved.approvalToken, { secret, sessionId });
    const created = await createWorkflow({
      userRequest: (spec && spec.goal) || 'conversational plan',
      candidateWorkflow: compiled.workflow,
      metadata: { compilerMode: 'conversational_plan', planFingerprint: compiled.planFingerprint },
    });
    return { status: created.status, payload: created.payload };
  };
}

module.exports = {
  createPlannerAdapter,
  createFakeCredentialResolver,
  createSetupRequiredResolver,
  createConversationCompileAndCreate,
  detectLanguage,
  resolveEffectiveLanguage,
  isLanguageMatch,
  resolveFallbackGoal,
  isDeltaInstruction,
  formatCapabilityGaps,
  TEMPLATES,
};
