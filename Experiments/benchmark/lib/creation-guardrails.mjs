/**
 * Runaway detection and post-parse salvage for creation inference.
 */

import { sanitizeWorkflowConnections } from './n8n-api.mjs';

export const MAX_STICKY_NOTES = Number(process.env.CREATE_MAX_STICKY_NOTES || 3);
export const RUNAWAY_STICKY_THRESHOLD = Number(process.env.CREATE_RUNAWAY_STICKY || 15);
export const RUNAWAY_LENGTH_THRESHOLD = Number(process.env.CREATE_RUNAWAY_LENGTH || 25000);

export const RETRY_USER_APPEND = `

Additional constraints (required):
- Output ONE complete n8n workflow JSON object only.
- Maximum 15 nodes total, including at most 3 sticky notes.
- Do NOT enumerate long API field lists; use minimal parameter objects.
- Do NOT repeat nodes or content. Stop immediately after the root closing brace.`;

/** Detect repetitive / runaway generation in accumulated model text. */
export function detectRunaway(text) {
  const t = String(text || '');
  if (!t.length) return { runaway: false };

  const stickyCount = (t.match(/stickyNote/gi) || []).length;
  if (stickyCount >= RUNAWAY_STICKY_THRESHOLD) {
    return { runaway: true, reason: 'sticky_note_loop', stickyCount };
  }

  if (t.length >= RUNAWAY_LENGTH_THRESHOLD) {
    const open = (t.match(/\{/g) || []).length;
    const close = (t.match(/\}/g) || []).length;
    if (open - close > 3) {
      return { runaway: true, reason: 'unclosed_json_at_length', length: t.length };
    }
  }

  const tail = t.slice(-3000);
  const repeatMatch = tail.match(/(.{40,}?)\1{3,}/s);
  if (repeatMatch) {
    return {
      runaway: true,
      reason: 'repetitive_tail',
      sample: repeatMatch[1].slice(0, 60),
    };
  }

  // Long comma-separated runs without structural progress (Google Ads enum loops).
  const longCommaRun = tail.match(/[\w.-]{20,}(?:,\s*[\w.-]{20,}){8,}/);
  if (longCommaRun) {
    return { runaway: true, reason: 'enum_list_loop', sample: longCommaRun[0].slice(0, 60) };
  }

  return { runaway: false };
}

function isStickyNode(node) {
  return String(node?.type || '').toLowerCase().includes('stickynote');
}

/** Drop excess stickyNote nodes and prune dangling connections. */
export function stripExcessStickyNotes(workflow, maxSticky = MAX_STICKY_NOTES) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  let stickySeen = 0;
  const kept = [];

  for (const node of nodes) {
    if (isStickyNode(node)) {
      stickySeen += 1;
      if (stickySeen > maxSticky) continue;
    }
    kept.push(node);
  }

  const out = { ...workflow, nodes: kept };
  sanitizeWorkflowConnections(out);
  return out;
}

/** If repair returned a sticky-note monster, trim and return salvaged workflow. */
export function tryStickySalvage(workflow) {
  if (!workflow?.nodes?.length) return null;
  const stickyCount = workflow.nodes.filter(isStickyNode).length;
  if (stickyCount <= MAX_STICKY_NOTES) return null;

  const salvaged = stripExcessStickyNotes(workflow);
  const functional = salvaged.nodes.filter((n) => !isStickyNode(n)).length;
  if (functional < 1) return null;

  return {
    workflow: salvaged,
    parseNote: 'sticky_salvage',
    strictParse: false,
    droppedSticky: stickyCount - MAX_STICKY_NOTES,
  };
}
