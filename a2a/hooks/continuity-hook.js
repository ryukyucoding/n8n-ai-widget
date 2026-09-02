#!/usr/bin/env node
'use strict';

// Emits Claude Code hook context only. It never fetches, edits, commits, pushes,
// starts a model, or sends a network request. A model must perform the guarded
// A2A reconciliation/handoff steps described in AGENT_CONTINUITY_PROTOCOL.md.

const event = process.argv[2];
const role = process.env.A2A_AGENT_ROLE || process.env.CLAUDE_CODE_SESSION_NAME || 'agent';

const messages = {
  'SessionStart': [
    `[A2A continuity: ${role}] Treat canonical A2A as the durable cross-machine fact source before planning work.`,
    'Do not assume local memory, an old transcript, or a relay is current.',
    'First reconcile the current A2A ref through the approved Git workflow, read AGENT_CONTINUITY_PROTOCOL.md, ORGANIZATION.md, your role/recovery document, latest relevant outboxes, CONTINUOUS_RESEARCH.md, NEEDS_HUMAN.md, and current branch refs.',
    'Then update only your own local memory/handoff with facts you actually verified; never overwrite another role’s memory or A2A state.',
    'Do not auto-fetch, write, commit, push, deploy, or claim a lock from this hook. Those actions retain normal authorization and single-writer rules.',
  ].join(' '),
  'PreCompact': [
    `[A2A continuity: ${role}] Before context compaction, make a checkpoint if material work has occurred since the last durable record.`,
    'Record only verified, sanitized facts: role/provider state, current ref/HEAD, branch/worktree state, completed evidence, in-progress task, next safe action, locks/writer ownership, blocked decisions, validation results, and local-only artifact locations without secrets.',
    'For cross-machine-relevant material changes, follow the A2A protocol to create a meaningful owned handoff/finding; routine progress belongs in the durable work log, not an empty outbox message.',
    'Never let this reminder authorize Git publication, deployment, credential handling, or a second same-identity writer.',
  ].join(' '),
};

if (!messages[event]) process.exit(0);
process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext: messages[event],
  },
})}\n`);
