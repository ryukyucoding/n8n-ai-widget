/**
 * Prompt profiles for creation benchmark ablation.
 *
 * Profiles (cumulative layers on top of each case's prompt.json user text):
 *   s1         — baseline system line from prompt.json only
 *   connection — + connection topology / name-key rules
 *   semantic   — + node-type selection + parameter guidance
 *   rich       — full n8n JSON schema (widget SYSTEM_PROMPT_CREATE style)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { modelSlugForResults } from './model-slug.mjs';

export const PROMPT_PROFILES = ['s1', 'connection', 'semantic', 'rich'];

const CONNECTION_RULES = `
Connection rules (required):
1. "connections" object keys MUST be the source node's "name" string — never node id or slug.
2. Each target's "node" field MUST be the target node's "name".
3. Every non-trigger node needs at least one incoming edge; every non-terminal node needs outgoing edges.
4. IF nodes: main[0] = true branch, main[1] = false branch; wire both when the workflow branches.
5. Start every workflow with a trigger (manualTrigger, scheduleTrigger, or webhook).`.trim();

const SEMANTIC_RULES = `
Node selection (required):
- Include ALL functional steps in the requirement: triggers, reads, transforms, branches, waits, loops, notifications, write-backs.
- Use the integration named in the requirement (e.g. googleSheets, httpRequest, telegram, openAi) with correct n8n type strings.
- Do not skip loop/merge/wait/error-handler nodes when the description implies them.

Parameter rules (required):
- Fill "parameters" with fields needed to implement the requirement (resource, operation, URLs, IDs, auth placeholders).
- Use n8n expressions for dynamic values: ={{ $json.field }} or ={{ $('Node Name').item.json.field }}.
- Match the parameter shape expected by each node type (IF conditions object, HTTP method/url, Sheets documentId, etc.).`.trim();

const RICH_SYSTEM = `You are an expert n8n workflow builder.
Reply with ONLY a valid JSON object — no prose, no markdown fences.

Schema:
{
  "name": "<descriptive workflow name>",
  "nodes": [
    {
      "id": "<unique string id>",
      "name": "<Node Display Name>",
      "type": "<n8n node type, e.g. n8n-nodes-base.scheduleTrigger>",
      "typeVersion": <number>,
      "position": [<x>, <y>],
      "parameters": { }
    }
  ],
  "connections": {
    "<Source Node Name>": {
      "main": [
        [{ "node": "<Target Node Name>", "type": "main", "index": 0 }]
      ]
    }
  },
  "settings": { "executionOrder": "v1" }
}

Position nodes left-to-right from [240, 300], +220 on x per node.

Rules:
1. Every workflow must start with a trigger node.
2. Node "id" values must be unique.
3. "connections" keys and target "node" values use node "name" — not id.
4. Return ONLY the JSON.`;

export function resolvePromptProfile(raw) {
  const p = String(raw || 's1').trim().toLowerCase();
  if (!PROMPT_PROFILES.includes(p)) {
    throw new Error(
      `Unknown --prompt-profile "${raw}". Choose: ${PROMPT_PROFILES.join(', ')}`
    );
  }
  return p;
}

/** results/local/create for s1; results/local/create-{profile} otherwise (FT models only) */
export function resultsRootForProfile(benchmarkRoot, profile) {
  const p = resolvePromptProfile(profile);
  if (p === 's1') {
    return resolve(benchmarkRoot, 'results/local/create');
  }
  return resolve(benchmarkRoot, `results/local/create-${p}`);
}

/** FT → create / create-{profile}; base model → create-{slug}-{profile} */
export function resultsRootForOneshot(benchmarkRoot, profile, model) {
  const p = resolvePromptProfile(profile);
  const m = String(model || '');
  if (m.startsWith('ft:')) {
    return resultsRootForProfile(benchmarkRoot, p);
  }
  const slug = modelSlugForResults(m);
  return resolve(benchmarkRoot, `results/local/create-${slug}-${p}`);
}

function readCasePrompt(benchmarkRoot, caseEntry) {
  const p = resolve(benchmarkRoot, `data/creation/${caseEntry.id}/prompt.json`);
  if (!existsSync(p)) {
    throw new Error(`Missing prompt.json for ${caseEntry.id}`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function buildSystem(profile, baseSystem) {
  const base = String(baseSystem || '').trim();

  if (profile === 'rich') {
    return `${RICH_SYSTEM}\n\n${CONNECTION_RULES}\n\n${SEMANTIC_RULES}`;
  }

  let system = base;
  if (profile === 'connection' || profile === 'semantic') {
    system = system ? `${system}\n\n${CONNECTION_RULES}` : CONNECTION_RULES;
  }
  if (profile === 'semantic') {
    system = `${system}\n\n${SEMANTIC_RULES}`;
  }
  return system;
}

/**
 * @returns {{ system: string, user: string, promptProfile: string, promptPath: string }}
 */
export function buildCreationPrompt(benchmarkRoot, caseEntry, profile = 's1') {
  const promptProfile = resolvePromptProfile(profile);
  const prompt = readCasePrompt(benchmarkRoot, caseEntry);
  const user = String(prompt.user || '').trim();
  if (!user) {
    throw new Error(`Empty user prompt for ${caseEntry.id}`);
  }
  const system = buildSystem(promptProfile, prompt.system);
  const promptPath = resolve(benchmarkRoot, `data/creation/${caseEntry.id}/prompt.json`);
  return { system, user, promptProfile, promptPath };
}
