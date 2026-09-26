#!/usr/bin/env node
/**
 * Playwright runner for n8n Cloud AI Workflow Builder.
 *
 * Prerequisite: npm run auth:cloud  (saves session cookies)
 *
 * Usage:
 *   node run_cloud.mjs --operation delete --limit 3
 */

import 'dotenv/config';
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, loadManifest, filterCases, sleep, resolveKeepWorkflow } from './lib/args.mjs';
import { promptInstruction, formatResultTag, formatInsertDetailLines } from './lib/result-tag.mjs';
import {
  stripWorkflowForImport,
  createWorkflow,
  getWorkflow,
  deleteWorkflow,
  waitForPersistedWorkflow,
  workflowSignature,
} from './lib/n8n-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = __dirname;

const CLOUD_URL = (process.env.N8N_CLOUD_URL || 'https://widmn8n.app.n8n.cloud').replace(/\/$/, '');
const CLOUD_API_KEY = process.env.N8N_CLOUD_API_KEY || '';
const STORAGE_STATE = resolve(BENCHMARK_ROOT, process.env.PLAYWRIGHT_STORAGE_STATE || 'playwright/.auth/storageState.json');
const MANIFEST_PATH = resolve(BENCHMARK_ROOT, process.env.BENCHMARK_MANIFEST || 'data/manifest.json');
const RESULTS_ROOT = resolve(BENCHMARK_ROOT, 'results/cloud');

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3.12';
const BUILDER_TIMEOUT_MS = Number(process.env.BUILDER_TIMEOUT_MS || 300000);
const OPEN_BUTTON_STRATEGIES = Number(process.env.OPEN_BUTTON_STRATEGIES || 4);
/** Auto-click Later / skip on post-build credential & execute-step wizard (default on). */
const SKIP_WORKFLOW_SETUP = process.env.BENCHMARK_SKIP_SETUP !== '0';
const BUILD_BUSY_SIGNALS = new Set([
  'stop_button',
  'loading_mask',
  'working_indicator',
  'thinking_label',
  'sidebar_tool_running',
]);

function isOnlySetupBlocking(signals) {
  return (
    signals.length > 0 &&
    signals.every((s) => s === 'workflow_setup_wizard' || s === 'chat_input_disabled')
  );
}

const OPEN_SELECTORS = [
  '[data-test-id="ask-assistant-canvas-action-button"]',
  '[data-test-id="ask-assistant-floating-button"]',
  '[data-test-id*="ask-assistant"][data-test-id*="button"]',
];

const OPEN_ROLE_NAMES = /Build with AI|AI Builder|Workflow Builder|Open AI|Ask AI|AI Assistant/i;

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

function scoreCase(operation, basePath, goldPath, predPath, caseEntry, outScorePath) {
  const caseJsonPath = join(dirname(outScorePath), 'case.json');
  writeJson(caseJsonPath, caseEntry);
  const proc = spawnSync(
    PYTHON_BIN,
    [
      join(BENCHMARK_ROOT, 'score_case.py'),
      '--operation',
      operation,
      '--base',
      basePath,
      '--gold',
      goldPath,
      '--pred',
      predPath,
      '--case-json',
      caseJsonPath,
      '--out',
      outScorePath,
    ],
    { env: { ...process.env }, encoding: 'utf8' }
  );
  let score = null;
  if (existsSync(outScorePath)) {
    try {
      score = readJson(outScorePath);
    } catch {
      score = null;
    }
  }
  return { ok: proc.status === 0, score };
}

function pushStep(meta, step, detail = undefined) {
  if (!meta.steps) meta.steps = [];
  meta.steps.push({ step, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
}

async function snapshot(page, outDir, name) {
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true }).catch(() => {});
}

async function dismissPageOverlays(page) {
  const cred = page.getByText(/One click credential setup/i);
  if (await cred.isVisible({ timeout: 600 }).catch(() => false)) {
    await page
      .locator('[data-test-id="close-button"], button[aria-label="Close"]')
      .first()
      .click({ force: true, timeout: 2000 })
      .catch(() => {});
    await sleep(400);
  }

  const toasts = page.locator('.el-notification__closeBtn, .el-message__closeBtn');
  const toastCount = await toasts.count().catch(() => 0);
  for (let i = 0; i < Math.min(toastCount, 3); i += 1) {
    await toasts.nth(i).click({ force: true, timeout: 1000 }).catch(() => {});
  }
}

async function waitForWorkflowCanvas(page) {
  await page
    .locator('[data-test-id="canvas"], [data-test-id="workflow-canvas"], .vue-flow')
    .first()
    .waitFor({ state: 'visible', timeout: 60000 });
  await sleep(2000);
}

async function scrollCanvas(page) {
  const canvas = page.locator('[data-test-id="canvas"], [data-test-id="workflow-canvas"], .vue-flow').first();
  if (!(await canvas.isVisible({ timeout: 3000 }).catch(() => false))) return;

  const box = await canvas.boundingBox().catch(() => null);
  if (!box) return;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);

  for (const delta of [400, -400, 800, -800, 0]) {
    await page.mouse.wheel(0, delta);
    await sleep(350);
  }
  // Also nudge horizontally — large workflows may push the FAB off-screen.
  for (const delta of [400, -400]) {
    await page.mouse.wheel(delta, 0);
    await sleep(250);
  }
}

async function isAssistantPanelOpen(page) {
  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  return sidebar.isVisible({ timeout: 800 }).catch(() => false);
}

async function tryClickOpenButton(page, meta, attemptLabel) {
  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  const attempts = [
    ...OPEN_SELECTORS.map((sel) => ({ type: 'selector', value: sel })),
    { type: 'role', value: OPEN_ROLE_NAMES },
  ];

  for (const attempt of attempts) {
    const btn =
      attempt.type === 'selector'
        ? page.locator(attempt.value).first()
        : page.getByRole('button', { name: attempt.value }).first();

    if ((await btn.count().catch(() => 0)) === 0) continue;
    await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    if (!(await btn.isVisible({ timeout: 2500 }).catch(() => false))) continue;

    await btn.click({ force: true, timeout: 10000 }).catch(() => {});
    await sleep(800);

    if (await isAssistantPanelOpen(page)) {
      pushStep(meta, 'clicked_open_button', {
        selector: attempt.type === 'selector' ? attempt.value : 'role:AI',
        attempt: attemptLabel,
      });
      return true;
    }
  }

  return false;
}

async function waitForBuilderPanel(page, meta) {
  const chat = page.locator('[data-test-id="ask-assistant-chat"]');
  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  await sidebar.waitFor({ state: 'visible', timeout: 25000 });
  pushStep(meta, 'sidebar_visible');
  await chat.waitFor({ state: 'visible', timeout: 25000 });
  const input = chat.locator('textarea, [contenteditable="true"]').first();
  await input.waitFor({ state: 'attached', timeout: 25000 });
  await sleep(500);
  pushStep(meta, 'chat_visible');
  return chat;
}

async function fillChatInput(chat, page, instruction, meta) {
  const input = chat.locator('textarea, [contenteditable="true"], input[type="text"]').first();
  await input.waitFor({ state: 'attached', timeout: 20000 });

  if (!(await isAssistantPanelOpen(page))) {
    throw new Error('AI Assistant panel closed before prompt could be filled');
  }

  const methods = ['fill_force', 'evaluate', 'click_fill'];
  let lastErr = null;

  for (const method of methods) {
    try {
      if (!(await isAssistantPanelOpen(page))) {
        throw new Error('AI Assistant panel not visible');
      }
      if (method === 'fill_force') {
        await input.fill(instruction, { force: true, timeout: 15000 });
      } else if (method === 'evaluate') {
        await input.evaluate((el, text) => {
          el.focus();
          if ('value' in el) el.value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, instruction);
      } else {
        await input.click({ force: true, timeout: 8000 });
        await input.fill(instruction, { timeout: 15000 });
      }
      pushStep(meta, 'prompt_filled', { chars: instruction.length, method });
      return input;
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }

  throw lastErr || new Error('Could not fill AI Builder chat input');
}

async function sendChatMessage(chat, input, meta) {
  const send = chat
    .locator(
      '[data-test-id="send-message-button"], [data-test-id="ask-assistant-send"], [data-test-id*="assistant-send"], button[aria-label="Send"]'
    )
    .first();

  const methods = ['enter', 'send_force', 'send_evaluate'];
  let lastErr = null;

  for (const method of methods) {
    try {
      if (method === 'enter') {
        await input.press('Enter');
      } else if (method === 'send_force') {
        if (!(await send.isVisible({ timeout: 1500 }).catch(() => false))) {
          continue;
        }
        await send.click({ force: true, timeout: 8000 });
      } else {
        await send.evaluate((btn) => btn.click());
      }
      await sleep(400);
      pushStep(meta, 'prompt_sent', { method });
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Could not send AI Builder message');
}

async function openAiBuilder(page, meta, workflowUrl) {
  const chat = page.locator('[data-test-id="ask-assistant-chat"]');
  if (await isAssistantPanelOpen(page)) {
    pushStep(meta, 'builder_already_open');
    return waitForBuilderPanel(page, meta);
  }

  const strategies = [
    { name: 'initial', reload: false, scroll: false },
    { name: 'scroll_canvas', reload: false, scroll: true },
    { name: 'reload_page', reload: true, scroll: false },
    { name: 'reload_and_scroll', reload: true, scroll: true },
  ].slice(0, OPEN_BUTTON_STRATEGIES);

  for (const strategy of strategies) {
    if (strategy.reload && workflowUrl) {
      await page.goto(workflowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      pushStep(meta, 'page_reloaded', strategy.name);
      await sleep(2500);
    }

    await dismissPageOverlays(page);
    await waitForWorkflowCanvas(page);
    pushStep(meta, 'canvas_ready', strategy.name);

    if (await isAssistantPanelOpen(page)) {
      pushStep(meta, 'builder_already_open', strategy.name);
      return waitForBuilderPanel(page, meta);
    }

    if (strategy.scroll) {
      await scrollCanvas(page);
      pushStep(meta, 'canvas_scrolled', strategy.name);
    }

    const opened = await tryClickOpenButton(page, meta, strategy.name);
    if (opened) {
      return waitForBuilderPanel(page, meta);
    }

    pushStep(meta, 'open_button_not_found', strategy.name);
    await snapshot(page, meta._outDir, `open-button-missing-${strategy.name}`);
  }

  throw new Error(
    'Could not open AI Assistant — canvas/floating Ask AI button not found or panel did not stay open.'
  );
}

async function captureAiChat(page, chat) {
  const fromChat = await chat.evaluate((root) => {
    const out = [];
    const selectors = [
      '[class*="assistantMessage"]',
      '[class*="userMessage"]',
      '[class*="message"]',
      '[class*="Message"]',
      '[data-test-id*="message"]',
    ];

    for (const sel of selectors) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length >= 1) {
        nodes.forEach((node) => {
          const text = (node.innerText || node.textContent || '').trim();
          if (!text) return;
          const cls = String(node.className || '');
          const role = /user/i.test(cls) ? 'user' : 'assistant';
          out.push({ role, text });
        });
        if (out.length) return out;
      }
    }

    const text = (root.innerText || root.textContent || '').trim();
    return text ? [{ role: 'raw', text }] : [];
  });

  if (fromChat.some((m) => m.role === 'assistant' || (m.role === 'raw' && m.text.length > 100))) {
    return fromChat;
  }

  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  if (await sidebar.isVisible({ timeout: 1000 }).catch(() => false)) {
    const sidebarText = (await sidebar.innerText().catch(() => '')).trim();
    if (sidebarText) {
      return [{ role: 'raw_sidebar', text: sidebarText }];
    }
  }

  return fromChat;
}

function parseAiBuildStream(bodyPreview) {
  if (!bodyPreview || typeof bodyPreview !== 'string') {
    return { assistantTexts: [], workflowUpdated: false, toolCalls: [] };
  }

  const assistantTexts = [];
  const toolCalls = [];
  let workflowUpdated = false;

  for (const chunk of bodyPreview.split('⧉⇋⇋➽⌑⧉§§')) {
    const line = chunk.trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      for (const msg of obj.messages || []) {
        if (msg.role === 'assistant' && msg.type === 'message' && msg.text) {
          assistantTexts.push(msg.text);
        }
        if (msg.type === 'workflow-updated') {
          workflowUpdated = true;
        }
        if (msg.type === 'tool' && msg.displayTitle) {
          toolCalls.push(`${msg.displayTitle}:${msg.status || 'unknown'}`);
        }
      }
    } catch {
      // ignore partial stream chunks
    }
  }

  return { assistantTexts, workflowUpdated, toolCalls };
}

function enrichAiOutcomeFromBuildResponses(aiOutcome, aiBuildResponses) {
  const parsed = parseAiBuildStream(
    (aiBuildResponses || [])
      .map((r) => r.bodyPreview)
      .filter(Boolean)
      .join('\n')
  );
  if (parsed.assistantTexts.length) {
    aiOutcome.lastAssistantText = parsed.assistantTexts[parsed.assistantTexts.length - 1].slice(0, 8000);
    aiOutcome.allAssistantText = parsed.assistantTexts.join('\n---\n').slice(0, 20000);
    aiOutcome.assistantMessageCount = parsed.assistantTexts.length;
    aiOutcome.aiReportedWorkflowUpdated = parsed.workflowUpdated;
    aiOutcome.toolCalls = parsed.toolCalls;

    const last = aiOutcome.lastAssistantText;
    if (!aiOutcome.workflowChanged) {
      aiOutcome.looksLikeClarification =
        /\?/.test(last) &&
        /which|what|please|could|would|confirm|clarif|specify|mean|should i|do you|can you|need/i.test(last);
      aiOutcome.looksLikePlanApproval = /approve|plan|proceed|review|confirm.*changes|apply.*changes|ready to/i.test(
        last
      );
      aiOutcome.looksLikeRefusal = /cannot|can't|unable|not able|read-only|don't have permission|need credentials/i.test(
        last
      );
      aiOutcome.looksLikeWrongEdit =
        parsed.workflowUpdated &&
        /delete|removed|deleted|insert|added|updated|modified|changed/i.test(last) &&
        !aiOutcome.workflowChanged;
    }
  }
  return aiOutcome;
}

function analyzeAiOutcome(chatMessages, instruction, baseWorkflow, predWorkflow) {
  const baseNodes = baseWorkflow?.nodes?.length ?? 0;
  const predNodes = predWorkflow?.nodes?.length ?? 0;
  const baseJson = JSON.stringify(baseWorkflow?.connections || {});
  const predJson = JSON.stringify(predWorkflow?.connections || {});

  const assistantTexts = chatMessages
    .filter((m) => m.role === 'assistant' || m.role === 'raw' || m.role === 'raw_sidebar')
    .map((m) => m.text)
    .filter(Boolean);
  const userTexts = chatMessages.filter((m) => m.role === 'user').map((m) => m.text).filter(Boolean);
  const lastAssistant = assistantTexts[assistantTexts.length - 1] || '';
  const allAssistant = assistantTexts.join('\n---\n');

  const workflowChanged = baseNodes !== predNodes || baseJson !== predJson;
  const looksLikeQuestion =
    /\?/.test(lastAssistant) &&
    /which|what|please|could|would|confirm|clarif|specify|mean|should i|do you|can you|need/i.test(
      lastAssistant
    );
  const looksLikePlanApproval =
    /approve|plan|proceed|review|confirm.*changes|apply.*changes|ready to/i.test(lastAssistant);
  const looksLikeRefusal =
    /cannot|can't|unable|not able|read-only|don't have permission|need credentials/i.test(lastAssistant);

  return {
    workflowChanged,
    baseNodeCount: baseNodes,
    predNodeCount: predNodes,
    lastAssistantText: lastAssistant.slice(0, 8000),
    allAssistantText: allAssistant.slice(0, 20000),
    userMessageCount: userTexts.length,
    assistantMessageCount: assistantTexts.length,
    looksLikeClarification: looksLikeQuestion && !workflowChanged,
    looksLikePlanApproval: looksLikePlanApproval && !workflowChanged,
    looksLikeRefusal: looksLikeRefusal,
    looksLikeWrongEdit: false,
    aiReportedWorkflowUpdated: false,
    toolCalls: [],
    instructionSent: instruction.slice(0, 500),
  };
}

function attachAiBuildListener(page, bucket) {
  const handler = async (response) => {
    if (!response.url().includes('/rest/ai/build')) return;
    if (response.request().method() !== 'POST') return;
    try {
      const body = await response.text();
      bucket.push({
        url: response.url(),
        status: response.status(),
        at: new Date().toISOString(),
        bodyPreview: body.slice(0, 100000),
      });
    } catch {
      bucket.push({
        url: response.url(),
        status: response.status(),
        at: new Date().toISOString(),
        bodyPreview: null,
      });
    }
  };
  page.on('response', handler);
  return () => page.off('response', handler);
}

async function workflowSetupWizardVisible(page) {
  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  if (!(await sidebar.isVisible({ timeout: 400 }).catch(() => false))) return false;
  return sidebar
    .getByText(/Complete these steps|finalize your workflow|Execute step|Set up credentials/i)
    .first()
    .isVisible({ timeout: 400 })
    .catch(() => false);
}

/** Dismiss n8n AI post-build setup wizard (credential / execute-step cards). */
async function dismissWorkflowSetup(page) {
  if (!SKIP_WORKFLOW_SETUP) return false;

  let dismissedAny = false;

  for (let round = 0; round < 12; round += 1) {
    if (!(await workflowSetupWizardVisible(page))) break;

    const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');

    // Some n8n versions expose Later; many Cloud builds only show Execute step + pagination.
    const later = sidebar.getByRole('button', {
      name: /^Later$|Set up later|Skip for now|Not now|Maybe later|Do this later|I'll connect apps later/i,
    });
    if (await later.first().isVisible({ timeout: 800 }).catch(() => false)) {
      await later.first().click({ timeout: 3000 }).catch(() => {});
      dismissedAny = true;
      await sleep(1500);
      continue;
    }

    // Advance "N of M" wizard without executing (click next chevron).
    const advanced = await sidebar
      .evaluate((el) => {
        const text = el.innerText || '';
        const match = text.match(/(\d+)\s+of\s+(\d+)/);
        if (!match) return false;
        const current = Number(match[1]);
        const total = Number(match[2]);
        if (current >= total) return false;

        const buttons = [...el.querySelectorAll('button')];
        for (const b of buttons) {
          const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
          if (/next|forward|skip/.test(label) && !b.disabled) {
            b.click();
            return true;
          }
        }

        // Icon chevrons beside "N of M" — pick the last enabled button before "Execute step".
        const executeIdx = text.indexOf('Execute step');
        const slice = executeIdx > 0 ? buttons.slice(0, Math.ceil(buttons.length * 0.7)) : buttons;
        const iconButtons = slice.filter((b) => b.querySelector('svg') && !b.disabled);
        if (iconButtons.length >= 2) {
          iconButtons[iconButtons.length - 1].click();
          return true;
        }
        return false;
      })
      .catch(() => false);

    if (advanced) {
      dismissedAny = true;
      await sleep(1200);
      continue;
    }

    break;
  }

  const promo = page.getByText(/One click credential setup/i);
  if (await promo.isVisible({ timeout: 400 }).catch(() => false)) {
    const close = page
      .locator('[data-test-id="close-button"], button[aria-label="Close"]')
      .filter({ has: page.locator('svg') })
      .first();
    if (await close.isVisible({ timeout: 800 }).catch(() => false)) {
      await close.click({ timeout: 2000 }).catch(() => {});
      dismissedAny = true;
    }
  }

  return dismissedAny;
}

async function dismissHitl(page) {
  await dismissWorkflowSetup(page);

  const buttons = [
    page.getByRole('button', {
      name: /Continue|Confirm|Apply|Accept|Yes|Proceed|Done|Save|Approve|Build|Implement|Run|Start/i,
    }),
    page.locator('[data-test-id*="confirm"]'),
    page.locator('[data-test-id*="approve"]'),
  ];
  for (let round = 0; round < 3; round += 1) {
    let clicked = false;
    for (const loc of buttons) {
      const btn = loc.first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        await sleep(1200);
      }
    }
    if (!clicked) break;
  }
}

async function probeBuilderBusy(page, chat) {
  const signals = [];

  const stopBtn = page.locator('[data-test-id="assistant-stop"], [data-test-id*="stop-generating"]');
  if (await stopBtn.first().isVisible({ timeout: 400 }).catch(() => false)) {
    signals.push('stop_button');
  }

  const loading = page.locator('[data-test-id*="loading"], .el-loading-mask');
  if (await loading.first().isVisible({ timeout: 400 }).catch(() => false)) {
    signals.push('loading_mask');
  }

  // Canvas / global "Working..." pill (see unchanged-after-ai screenshots)
  const working = page.getByText(/Working/i);
  if (await working.first().isVisible({ timeout: 400 }).catch(() => false)) {
    signals.push('working_indicator');
  }

  const thinking = page.getByText(/^Thinking$/i);
  if (await thinking.first().isVisible({ timeout: 400 }).catch(() => false)) {
    signals.push('thinking_label');
  }

  const input = chat.locator('textarea, [contenteditable="true"], input[type="text"]').first();
  if (await input.isVisible({ timeout: 400 }).catch(() => false)) {
    if (await input.isDisabled().catch(() => false)) {
      signals.push('chat_input_disabled');
    }
  }

  const sidebar = page.locator('[data-test-id="ask-assistant-sidebar"]');
  if (await sidebar.isVisible({ timeout: 400 }).catch(() => false)) {
    if (await workflowSetupWizardVisible(page)) {
      signals.push('workflow_setup_wizard');
    }

    const running = await sidebar
      .evaluate((el) => {
        const t = el.innerText || '';
        if (/Crafting workflow|Getting node definitions|Editing workflow|Validating workflow/i.test(t)) {
          if (/running|…|\.\.\./i.test(t)) return true;
        }
        return false;
      })
      .catch(() => false);
    if (running) signals.push('sidebar_tool_running');
  }

  return signals;
}

async function waitForChatInputReady(chat, page, meta, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissHitl(page);
    const busy = await probeBuilderBusy(page, chat);
    const input = chat.locator('textarea, [contenteditable="true"], input[type="text"]').first();
    const visible = await input.isVisible({ timeout: 500 }).catch(() => false);
    const enabled = visible && !(await input.isDisabled().catch(() => true));
    if (enabled && busy.length === 0) {
      meta.chatInputReady = { busySignals: [], ready: true };
      return;
    }
    await sleep(1000);
  }
  const lastBusy = await probeBuilderBusy(page, chat);
  meta.chatInputReady = { busySignals: lastBusy, ready: false, timedOut: true };
  throw new Error(`AI Builder chat input not ready (last busy: ${lastBusy.join(', ')})`);
}

async function waitForBuilderIdleOrPersist(page, chat, meta, baseline) {
  const workflowId = meta.workflowId;
  const baseSig = workflowSignature(baseline);
  const deadline = Date.now() + BUILDER_TIMEOUT_MS;
  let stable = 0;
  let persistStable = 0;
  let lastBusy = [];
  let lastWorkflow = null;

  while (Date.now() < deadline) {
    await dismissHitl(page);

    let persisted = false;
    if (workflowId && CLOUD_API_KEY) {
      try {
        lastWorkflow = await getWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
        persisted = workflowSignature(lastWorkflow) !== baseSig;
      } catch {
        /* ignore transient API errors */
      }
    }

    lastBusy = await probeBuilderBusy(page, chat);
    const buildBusy = lastBusy.some((s) => BUILD_BUSY_SIGNALS.has(s));

    if (persisted && !buildBusy) {
      persistStable += 1;
      if (persistStable >= 2 || isOnlySetupBlocking(lastBusy)) {
        meta.builderIdle = {
          busySignals: lastBusy,
          earlyExit: 'workflow_persisted',
          persistStable,
        };
        meta.earlyPersistedWorkflow = lastWorkflow;
        return;
      }
    } else {
      persistStable = 0;
    }

    if (lastBusy.length === 0) {
      const input = chat.locator('textarea, [contenteditable="true"], input[type="text"]').first();
      const inputReady =
        (await input.isVisible({ timeout: 400 }).catch(() => false)) &&
        !(await input.isDisabled().catch(() => true));
      // Do not treat "no busy signals" as idle while the chat input is still hidden/disabled
      // (AI may be editing without showing stop/loading indicators).
      if (inputReady) {
        stable += 1;
        if (stable >= 5) {
          meta.builderIdle = { busySignals: [], stablePolls: stable };
          return;
        }
      } else {
        stable = 0;
      }
    } else if (persisted && isOnlySetupBlocking(lastBusy)) {
      meta.builderIdle = {
        busySignals: lastBusy,
        earlyExit: 'setup_wizard_after_persist',
      };
      meta.earlyPersistedWorkflow = lastWorkflow;
      return;
    } else {
      stable = 0;
    }

    await sleep(2000);
  }

  if (lastWorkflow && workflowSignature(lastWorkflow) !== baseSig) {
    meta.builderIdle = { busySignals: lastBusy, earlyExit: 'persisted_on_timeout' };
    meta.earlyPersistedWorkflow = lastWorkflow;
    return;
  }

  meta.builderIdle = { busySignals: lastBusy, timedOut: true };
  throw new Error(
    `AI Builder timed out after ${BUILDER_TIMEOUT_MS}ms (last busy: ${lastBusy.join(', ')})`
  );
}

async function recoverAfterChatInputTimeout(meta, baseline) {
  const workflowId = meta.workflowId;
  if (!workflowId || !CLOUD_API_KEY || !baseline) return false;
  try {
    const wf = await getWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
    if (workflowSignature(wf) === workflowSignature(baseline)) return false;
    meta.earlyPersistedWorkflow = wf;
    meta.chatInputReady = {
      ...(meta.chatInputReady || {}),
      ready: false,
      skipped: 'chat_input_timeout_workflow_persisted',
    };
    return true;
  } catch {
    return false;
  }
}

async function waitForChatInputReadyAfterBuild(chat, page, meta, timeoutMs = 90000) {
  if (meta.builderIdle?.earlyExit) {
    meta.chatInputReady = {
      busySignals: [],
      ready: false,
      skipped: `post_build_${meta.builderIdle.earlyExit}`,
    };
    return;
  }
  try {
    await waitForChatInputReady(chat, page, meta, timeoutMs);
  } catch (err) {
    if (meta.earlyPersistedWorkflow) {
      meta.chatInputReady = {
        busySignals: meta.chatInputReady?.busySignals || [],
        ready: false,
        skipped: 'setup_wizard_blocks_input',
      };
      return;
    }
    throw err;
  }
}

async function sendBuilderPrompt(page, instruction, meta, workflowUrl, baseline) {
  const aiBuildResponses = [];
  const detachListener = attachAiBuildListener(page, aiBuildResponses);

  try {
    await dismissPageOverlays(page);
    const chat = await openAiBuilder(page, meta, workflowUrl);

    await waitForChatInputReady(chat, page, meta);
    const input = await fillChatInput(chat, page, instruction, meta);

    const streamDone = page
      .waitForResponse(
        async (r) => {
          if (!r.url().includes('/rest/ai/build') || r.request().method() !== 'POST') return false;
          await r.finished();
          return true;
        },
        { timeout: BUILDER_TIMEOUT_MS }
      )
      .catch(() => null);

    await sendChatMessage(chat, input, meta);

    await waitForBuilderIdleOrPersist(page, chat, meta, baseline);
    pushStep(meta, 'builder_idle', meta.builderIdle);

    try {
      await waitForChatInputReadyAfterBuild(chat, page, meta, 120000);
    } catch (err) {
      if (!(await recoverAfterChatInputTimeout(meta, baseline))) {
        throw err;
      }
    }
    pushStep(meta, 'chat_input_ready', meta.chatInputReady);

    await streamDone;
    await sleep(1000);

    if (meta._outDir) {
      await snapshot(page, meta._outDir, 'after-ai-idle');
    }

    const chatMessages = await captureAiChat(page, chat);
    meta.aiChat = {
      messages: chatMessages,
      capturedAt: new Date().toISOString(),
    };

    const aiResp = aiBuildResponses.length
      ? null
      : await page
          .waitForResponse(
            (r) => r.url().includes('/rest/ai/build') && r.request().method() === 'POST',
            { timeout: 5000 }
          )
          .catch(() => null);
    if (aiResp) {
      const bodyPreview = await aiResp.text().catch(() => null);
      aiBuildResponses.push({
        url: aiResp.url(),
        status: aiResp.status(),
        at: new Date().toISOString(),
        bodyPreview: bodyPreview ? bodyPreview.slice(0, 100000) : null,
      });
      pushStep(meta, 'ai_build_request', { status: aiResp.status() });
    } else if (aiBuildResponses.length) {
      pushStep(meta, 'ai_build_request', { status: aiBuildResponses[aiBuildResponses.length - 1].status });
    } else {
      pushStep(meta, 'ai_build_request', { status: 'not_detected' });
    }

    meta.aiBuildResponses = aiBuildResponses;
    writeJson(join(meta._outDir, 'ai_chat.json'), meta.aiChat);
    if (aiBuildResponses.length) {
      writeJson(join(meta._outDir, 'ai_build_responses.json'), aiBuildResponses);
    }

    return chat;
  } finally {
    detachListener();
  }
}

function resultDir(caseEntry) {
  const op = caseEntry.scoring_operation || caseEntry.operation;
  return join(RESULTS_ROOT, op, caseEntry.id);
}

function scoringOperation(caseEntry) {
  return caseEntry.scoring_operation || caseEntry.operation;
}

async function runOneCase(page, caseEntry, { dryRun, skipScore, keepWorkflow, force }) {
  const basePath = resolve(BENCHMARK_ROOT, caseEntry.base_path);
  const goldPath = resolve(BENCHMARK_ROOT, caseEntry.gold_path);
  const outDir = resultDir(caseEntry);
  ensureDir(outDir);

  if (!force && existsSync(join(outDir, 'pred.json')) && existsSync(join(outDir, 'score.json'))) {
    console.log(`[skip] ${caseEntry.id}`);
    return { skipped: true };
  }

  const instruction = promptInstruction(caseEntry);
  if (!instruction) {
    throw new Error(`Missing instruction for ${caseEntry.id}`);
  }
  if (dryRun) {
    console.log(`[dry-run] ${caseEntry.id}`);
    return { dryRun: true };
  }

  if (!CLOUD_API_KEY) {
    throw new Error('N8N_CLOUD_API_KEY is required');
  }

  const base = readJson(basePath);
  const started = Date.now();
  let workflowId = null;
  const meta = {
    caseId: caseEntry.id,
    operation: caseEntry.operation,
    startedAt: new Date().toISOString(),
    steps: [],
    _outDir: outDir,
  };

  try {
    const doc = stripWorkflowForImport(base, `cloud-bench-${caseEntry.id}`);
    const created = await createWorkflow(CLOUD_URL, CLOUD_API_KEY, doc);
    workflowId = created.id;
    meta.workflowId = workflowId;
    meta.workflowUrl = `${CLOUD_URL}/workflow/${workflowId}`;
    pushStep(meta, 'workflow_imported', { workflowId });

    await page.goto(meta.workflowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pushStep(meta, 'page_loaded');
    await dismissPageOverlays(page);
    await sleep(1500);

    await sendBuilderPrompt(page, instruction, meta, meta.workflowUrl, base);

    const persist = meta.earlyPersistedWorkflow
      ? {
          workflow: meta.earlyPersistedWorkflow,
          persisted: true,
          attempts: 0,
          elapsedMs: 0,
          source: 'early_api_poll',
        }
      : await waitForPersistedWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId, base, {
          page,
          timeoutMs: Number(process.env.PERSIST_TIMEOUT_MS || 90000),
        });
    meta.persist = {
      persisted: persist.persisted,
      attempts: persist.attempts,
      elapsedMs: persist.elapsedMs,
    };
    pushStep(meta, 'workflow_fetched', meta.persist);

    const pred = persist.workflow;
    const predPath = join(outDir, 'pred.json');
    writeJson(predPath, pred);

    meta.aiOutcome = enrichAiOutcomeFromBuildResponses(
      analyzeAiOutcome(meta.aiChat?.messages || [], instruction, base, pred),
      meta.aiBuildResponses
    );
    pushStep(meta, 'ai_outcome_recorded', {
      workflowChanged: meta.aiOutcome.workflowChanged,
      looksLikeClarification: meta.aiOutcome.looksLikeClarification,
      looksLikePlanApproval: meta.aiOutcome.looksLikePlanApproval,
      looksLikeWrongEdit: meta.aiOutcome.looksLikeWrongEdit,
      aiReportedWorkflowUpdated: meta.aiOutcome.aiReportedWorkflowUpdated,
    });

    if (!meta.aiOutcome.workflowChanged) {
      if (meta.aiOutcome.looksLikeWrongEdit) {
        meta.runNote =
          'AI reported edits in /rest/ai/build stream but GET workflow still matches baseline after persist wait.';
      } else if (meta.aiOutcome.looksLikeClarification) {
        meta.runNote =
          'Workflow unchanged — AI may have asked a clarifying question. See ai_chat.json / aiOutcome.lastAssistantText.';
      } else if (meta.aiOutcome.looksLikePlanApproval) {
        meta.runNote =
          'Workflow unchanged — AI may be waiting for plan approval. See ai_chat.json and unchanged-after-ai screenshot.';
      } else if (meta.aiOutcome.lastAssistantText) {
        meta.runNote =
          'Workflow unchanged after AI response. See ai_chat.json, ai_build_responses.json, aiOutcome.lastAssistantText.';
      } else {
        meta.runNote = 'Workflow unchanged and no assistant text captured from chat panel.';
      }
      await snapshot(page, outDir, 'unchanged-after-ai');
    }

    meta.elapsedMs = Date.now() - started;
    writeJson(join(outDir, 'meta.json'), meta);

    if (!skipScore) {
      const { ok, score } = scoreCase(
        scoringOperation(caseEntry),
        basePath,
        goldPath,
        predPath,
        caseEntry,
        join(outDir, 'score.json')
      );
      const tag = formatResultTag({
        operation: caseEntry.operation,
        score,
        meta,
      });
      console.log(`[${tag}] ${caseEntry.id} (${meta.elapsedMs}ms)`);
      if (score?.insert_status_label && caseEntry.operation?.startsWith('insert')) {
        console.log(`  insert: ${score.insert_status_label} (${score.insert_status || score.insert_tier})`);
        if (score.insert_detail?.summary_zh) {
          console.log(`  ${score.insert_detail.summary_zh}`);
        }
        for (const line of formatInsertDetailLines(score)) {
          console.log(line);
        }
      }
      if (meta.runNote) console.log(`  note: ${meta.runNote}`);
      return { success: ok, insertStatus: score?.insert_status_label };
    }
    console.log(`[done] ${caseEntry.id}`);
    return {};
  } catch (err) {
    meta.error = err.message || String(err);
    meta.failedStep = meta.steps?.[meta.steps.length - 1]?.step || 'unknown';
    meta.elapsedMs = Date.now() - started;
    writeJson(join(outDir, 'meta.json'), meta);
    await snapshot(page, outDir, 'error');
    console.error(`[error] ${caseEntry.id} @ ${meta.failedStep}: ${meta.error}`);
    return { error: meta.error };
  } finally {
    const metaPath = join(outDir, 'meta.json');
    if (workflowId) {
      if (keepWorkflow) {
        meta.workflowKept = true;
        meta.workflowDeleted = false;
        console.log(`  workflow kept: ${meta.workflowUrl}`);
      } else {
        try {
          await deleteWorkflow(CLOUD_URL, CLOUD_API_KEY, workflowId);
          meta.workflowDeleted = true;
          meta.workflowKept = false;
        } catch (e) {
          meta.workflowDeleted = false;
          meta.workflowDeleteError = e.message || String(e);
          console.warn(`  workflow cleanup failed (${workflowId}): ${meta.workflowDeleteError}`);
        }
      }
      let diskMeta = {};
      if (existsSync(metaPath)) {
        try {
          diskMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      writeJson(metaPath, { ...diskMeta, ...meta });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`Missing manifest: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  if (!existsSync(STORAGE_STATE)) {
    console.error(`Missing Playwright auth. Run: npm run auth:cloud`);
    process.exit(1);
  }

  const manifest = loadManifest(MANIFEST_PATH);
  const credentialTier = args['credential-tier'] || process.env.BENCHMARK_CREDENTIAL_TIER || null;
  const cases = filterCases(manifest, {
    operation: args.operation || 'all',
    limit: args.limit,
    offset: args.offset,
    caseId: args['case-id'],
    credentialTier,
    credentialScan: args['credential-scan'] || process.env.BENCHMARK_CREDENTIAL_SCAN,
  });

  const browser = await chromium.launch({ headless: args.headless !== 'false' });
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: { width: 1440, height: 900 },
  });

  console.log(`Cloud benchmark: ${cases.length} cases on ${CLOUD_URL}`);
  if (credentialTier) {
    console.log(`Credential filter: tier ${credentialTier} (see data/insert_credential_scan.json)`);
  }
  if (resolveKeepWorkflow(args)) {
    console.log('Workflow cleanup: KEEP (set BENCHMARK_KEEP_WORKFLOW=0 or --no-keep-workflow to auto-delete)');
  }
  if (SKIP_WORKFLOW_SETUP) {
    console.log(
      'Post-build setup: skip via API early-exit when workflow persisted (no Later button on current Cloud UI)'
    );
  }

  for (const c of cases) {
    const page = await context.newPage();
    try {
      await runOneCase(page, c, {
        dryRun: !!args['dry-run'],
        skipScore: !!args['skip-score'],
        keepWorkflow: resolveKeepWorkflow(args),
        force: !!args.force,
      });
    } finally {
      await page.close().catch(() => {});
    }
    await sleep(Number(args.delay || 2000));
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
