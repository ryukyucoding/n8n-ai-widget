'use strict';

function isWorkflowEnvelope(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.nodes) && value.connections && typeof value.connections === 'object'
    && !Array.isArray(value.connections));
}

// Equivalent to the Create path's extractJsonObject: full response first,
// then balanced-object candidates while respecting quoted strings and escapes.
function extractCreateJsonObject(rawText) {
  const candidates = [rawText.trim()];
  for (let start = rawText.indexOf('{'); start >= 0; start = rawText.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < rawText.length; index += 1) {
      const character = rawText[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(rawText.slice(start, index + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Keep scanning, exactly as the Create extractor does.
    }
  }
  return null;
}

function parseJsonCandidate(value) {
  if (value && typeof value === 'object') {
    const workflow = isWorkflowEnvelope(value);
    return { ok: workflow, value: workflow ? value : undefined, outputCategory: workflow ? 'strict_json' : 'non_workflow_json', strictJsonStatus: 'pass', repairedJsonStatus: workflow ? 'pass' : 'fail' };
  }
  if (typeof value !== 'string') return { ok: false, outputCategory: 'non_json_response', strictJsonStatus: 'not_run', repairedJsonStatus: 'fail' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, outputCategory: 'empty_output', strictJsonStatus: 'not_run', repairedJsonStatus: 'fail' };
  let strictObject = null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) strictObject = parsed;
  } catch {
    // Repaired path is below.
  }
  const extracted = strictObject || extractCreateJsonObject(value);
  if (!extracted) return { ok: false, outputCategory: 'non_json_response', strictJsonStatus: 'fail', repairedJsonStatus: 'fail' };
  if (!isWorkflowEnvelope(extracted)) return { ok: false, outputCategory: 'non_workflow_json', strictJsonStatus: strictObject ? 'pass' : 'fail', repairedJsonStatus: 'fail' };
  if (strictObject) return { ok: true, value: extracted, outputCategory: 'strict_json', strictJsonStatus: 'pass', repairedJsonStatus: 'pass' };
  return { ok: true, value: extracted, outputCategory: /^```/i.test(trimmed) ? 'markdown_fenced_json' : 'prose_plus_json', strictJsonStatus: 'fail', repairedJsonStatus: 'pass' };
}

function availabilityFailure(error) {
  if (error?.name === 'AbortError' || error?.stage === 'timeout' || error?.kind === 'timeout') return 'timeout';
  if (['route_unconfigured', 'model_not_found', 'auth_failure', 'http_failure', 'transport', 'sdk_error', 'unclassified_client_response'].includes(error?.kind)) return error.kind;
  return 'transport_error';
}

function safeContentType(value) {
  return typeof value === 'string' && /^application\/json(?:;|$)/i.test(value) ? 'application_json' : 'other_or_unavailable';
}

module.exports = { availabilityFailure, parseJsonCandidate, safeContentType };
