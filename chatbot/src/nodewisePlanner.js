'use strict';

const { NODEWISE_PLANNER_RESULT_PROMPT } = require('./nodewisePlannerPrompt');
const { validatePlannerEnvelope } = require('./nodewisePlannerEnvelope');
const { sanitizePlanSpec } = require('./planSpecSanitizer');

function assertUserRequest(userRequest) {
  if (typeof userRequest !== 'string' || !userRequest.trim()) {
    throw new Error('message is required');
  }
  return userRequest.trim();
}

function parsePlannerResponse(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('planner returned an empty response');
  }
  try {
    return JSON.parse(content);
  } catch (_) {
    throw new Error('planner returned invalid JSON');
  }
}

async function requestNodewisePlannerResult({ client, model, userRequest, previousSpecification = null, signal }) {
  if (!client || !client.chat || !client.chat.completions) {
    throw new Error('planner client is unavailable');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('planner model is not configured');
  }
  const currentRequest = assertUserRequest(userRequest);
  const safePrevious = previousSpecification == null ? null : sanitizePlanSpec(previousSpecification);
  const userContent = safePrevious
    ? `${currentRequest}\n\nPrevious sanitized specification (use only as the existing conversation plan; preserve it unless this request explicitly changes it):\n${JSON.stringify(safePrevious)}`
    : currentRequest;
  const response = await client.chat.completions.create({
    model: model.trim(),
    max_tokens: 2600,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: NODEWISE_PLANNER_RESULT_PROMPT },
      { role: 'user', content: userContent },
    ],
  }, { signal });
  return validatePlannerEnvelope(parsePlannerResponse(response.choices?.[0]?.message?.content));
}

module.exports = { assertUserRequest, parsePlannerResponse, requestNodewisePlannerResult };
