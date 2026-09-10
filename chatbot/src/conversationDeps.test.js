'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlannerAdapter,
  createSetupRequiredResolver,
  detectLanguage,
  resolveEffectiveLanguage,
  isLanguageMatch,
  resolveFallbackGoal,
  isDeltaInstruction,
  formatCapabilityGaps,
  TEMPLATES,
} = require('./conversationDeps');

// ---- planner adapter: maps reviewNodewisePlannerResult envelopes -> controller contract ----
test('planner adapter maps a ready review envelope -> ready_to_compile + spec + message', async () => {
  const review = async () => ({ outcome: 'ready_to_compile', specification: { goal: 'read todos', steps: [{}, {}] }, plan: { goal: 'read todos', steps: [{}, {}] } });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'hi', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  assert.deepEqual(r.spec, { goal: 'read todos', steps: [{}, {}] });
  assert.match(r.assistantMessage, /read todos/);
});

test('planner adapter maps clarification -> clarification_required, no spec, asks for the inputs', async () => {
  const review = async () => ({ outcome: 'clarification_required', goal: 'do a thing', requiredUserInputs: ['which calendar', 'how many'] });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'x', previousSpec: null });
  assert.equal(r.outcome, 'clarification_required');
  assert.equal(r.spec, null);
  assert.match(r.assistantMessage, /which calendar/);
});

test('planner adapter maps unsupported -> unsupported_capability, no spec', async () => {
  const review = async () => ({ outcome: 'unsupported_capability', goal: 'g', capabilityGaps: ['transform.pivot'] });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'x', previousSpec: null });
  assert.equal(r.outcome, 'unsupported_capability');
  assert.equal(r.spec, null);
  assert.match(r.assistantMessage, /不支援|transform\.pivot/);
});

test('planner adapter forwards previousSpec to the review fn', async () => {
  const seen = [];
  const review = async (message, previousSpec) => { seen.push({ message, previousSpec }); return { outcome: 'clarification_required', goal: 'g', requiredUserInputs: ['x'] }; };
  const plan = createPlannerAdapter(review);
  await plan({ message: 'm', previousSpec: { goal: 'prev' } });
  assert.equal(seen[0].message, 'm');
  assert.deepEqual(seen[0].previousSpec, { goal: 'prev' });
});

// ---- setup_required credential resolver STUB (no n8n probe until API verified) ----
test('setup_required stub: no required credential types -> ready / bind_and_create', async () => {
  const resolve = createSetupRequiredResolver(() => []);
  const r = await resolve({ goal: 'public data' });
  assert.equal(r.overall, 'ready');
  assert.equal(r.createDisposition, 'bind_and_create');
  assert.deepEqual(r.requirements, []);
});

test('setup_required stub: required types -> setup_required / create_inactive_draft (never auto-ready)', async () => {
  const resolve = createSetupRequiredResolver(() => ['googleCalendarOAuth2Api']);
  const r = await resolve({ goal: 'read calendar' });
  assert.equal(r.overall, 'setup_required');
  assert.equal(r.createDisposition, 'create_inactive_draft');
  assert.equal(r.requirements[0].credentialType, 'googleCalendarOAuth2Api');
  assert.equal(r.requirements[0].status, 'setup_required');
});

// ---- confirm goes through the HMAC approval gate (never raw compile+create) ----
const { createConversationCompileAndCreate } = require('./conversationDeps');

test('compileAndCreate: approve -> compileApproved(same token) -> create, in order', async () => {
  const calls = [];
  const compileAndCreate = createConversationCompileAndCreate({
    approve: (spec, opts) => { calls.push(['approve', spec.goal, opts.sessionId]); return { approvalToken: 'TOK' }; },
    compileApproved: (spec, token, opts) => { calls.push(['compileApproved', spec.goal, token, opts.sessionId]); return { workflow: { name: 'wf' }, planFingerprint: 'fp' }; },
    createWorkflow: async ({ candidateWorkflow }) => { calls.push(['create', candidateWorkflow.name]); return { status: 200, payload: { workflowId: 'x' } }; },
    secret: 's',
  });
  const r = await compileAndCreate({ goal: 'g' }, {}, { conversationId: 'conv-1' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [
    ['approve', 'g', 'conv-1'],
    ['compileApproved', 'g', 'TOK', 'conv-1'],
    ['create', 'wf'],
  ]);
});

test('compileAndCreate: NO create if approval verification fails (compileApproved throws)', async () => {
  let created = 0;
  const compileAndCreate = createConversationCompileAndCreate({
    approve: () => ({ approvalToken: 'TOK' }),
    compileApproved: () => { throw new Error('approval token does not match specification'); }, // mutation/mismatch
    createWorkflow: async () => { created += 1; return { status: 200, payload: {} }; },
    secret: 's',
  });
  await assert.rejects(() => compileAndCreate({ goal: 'g' }, {}, { conversationId: 'c' }), /approval token/);
  assert.equal(created, 0); // never created without a verified approval
});

test('createConversationCompileAndCreate requires all deps', () => {
  assert.throws(() => createConversationCompileAndCreate({ approve: () => {}, compileApproved: () => {} }), /requires/);
});

test('compileAndCreate FAILS CLOSED (stage-4) if the spec requires a credential', async () => {
  let created = 0;
  const compileAndCreate = createConversationCompileAndCreate({
    approve: () => ({ approvalToken: 'TOK' }),
    compileApproved: () => ({ workflow: {}, planFingerprint: 'fp' }),
    createWorkflow: async () => { created += 1; return { status: 200, payload: {} }; },
    secret: 's',
  });
  await assert.rejects(
    () => compileAndCreate({ goal: 'g' }, { requirements: [{ credentialType: 't', status: 'ready' }], overall: 'ready' }, { conversationId: 'c' }),
    /credential binding not yet supported/,
  );
  assert.equal(created, 0); // never creates a credentialed spec until stage-4
});

// ---- bilingual output tests ----
test('detectLanguage classifies text based on CJK characters', () => {
  assert.equal(detectLanguage('Fetch JSONPlaceholder todos'), 'en');
  assert.equal(detectLanguage('抓取 JSONPlaceholder todos'), 'zh');
  assert.equal(detectLanguage('請幫我做自動化'), 'zh');
  assert.equal(detectLanguage(''), 'en');
  assert.equal(detectLanguage(null), 'en');
});

test('planner adapter produces localized Traditional Chinese assistantMessage for Chinese input', async () => {
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '抓取使用者 1 並統計未完成項目', steps: [{}, {}] },
    plan: { goal: '抓取使用者 1 並統計未完成項目', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '請幫我抓取使用者 1 的待辦事項', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  assert.match(r.assistantMessage, /^已規劃：抓取使用者 1 並統計未完成項目（2 步）。確認即可建立/);
});

test('planner adapter localizes raw English goal when user message is Chinese (safe fallback)', async () => {
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: 'Fetch JSONPlaceholder user 1 and summarize todos.', steps: [{}, {}] },
    plan: { goal: 'Fetch JSONPlaceholder user 1 and summarize todos.', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '抓取使用者 1 的待辦清單', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  // Safe fallback replaces raw English goal with localized user intent
  assert.equal(r.spec.goal, '抓取使用者 1 的待辦清單');
  assert.match(r.assistantMessage, /^已規劃：抓取使用者 1 的待辦清單（2 步）。確認即可建立/);
});

test('planner adapter produces localized English assistantMessage for English input', async () => {
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: 'Fetch user 1 and count todos', steps: [{}, {}] },
    plan: { goal: 'Fetch user 1 and count todos', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'Fetch user 1 and count todos', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  assert.match(r.assistantMessage, /^Planned: Fetch user 1 and count todos \(2 steps\)\. Confirm to create/);
});

test('planner adapter produces localized clarification messages for both Chinese and English', async () => {
  const zhReview = async () => ({ outcome: 'clarification_required', requiredUserInputs: ['哪個日曆', '幾筆'] });
  const zhPlan = createPlannerAdapter(zhReview);
  const zhR = await zhPlan({ message: '查詢日曆', previousSpec: null });
  assert.match(zhR.assistantMessage, /^需要更多資訊：哪個日曆、幾筆/);

  const enReview = async () => ({ outcome: 'clarification_required', requiredUserInputs: ['which calendar', 'how many'] });
  const enPlan = createPlannerAdapter(enReview);
  const enR = await enPlan({ message: 'query calendar', previousSpec: null });
  assert.match(enR.assistantMessage, /^More information needed: which calendar, how many/);
});

test('planner adapter produces localized unsupported messages for both Chinese and English', async () => {
  const zhReview = async () => ({ outcome: 'unsupported_capability', capabilityGaps: ['delivery.telegram'] });
  const zhPlan = createPlannerAdapter(zhReview);
  const zhR = await zhPlan({ message: '寄送到 Telegram', previousSpec: null });
  assert.match(zhR.assistantMessage, /^目前不支援此需求：delivery\.telegram/);

  const enReview = async () => ({ outcome: 'unsupported_capability', capabilityGaps: ['delivery.telegram'] });
  const enPlan = createPlannerAdapter(enReview);
  const enR = await enPlan({ message: 'Send to Telegram', previousSpec: null });
  assert.match(enR.assistantMessage, /^This requirement is currently not supported: delivery\.telegram/);
});

test('isLanguageMatch validates text against target language symmetrically', () => {
  assert.equal(isLanguageMatch('抓取 todos', 'zh'), true);
  assert.equal(isLanguageMatch('Fetch todos', 'zh'), false);
  assert.equal(isLanguageMatch('Fetch todos', 'en'), true);
  assert.equal(isLanguageMatch('抓取 todos', 'en'), false);
  assert.equal(isLanguageMatch('', 'zh'), false);
  assert.equal(isLanguageMatch(null, 'en'), false);
});

test('planner adapter symmetrically localizes Chinese goal when user message is English (drift fallback)', async () => {
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '抓取使用者 1 並統計項目', steps: [{}, {}] },
    plan: { goal: '抓取使用者 1 並統計項目', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'Fetch user 1 and count items', previousSpec: null });
  assert.equal(r.outcome, 'ready_to_compile');
  // Symmetrically localizes to English user intent
  assert.equal(r.spec.goal, 'Fetch user 1 and count items');
  assert.match(r.assistantMessage, /^Planned: Fetch user 1 and count items \(2 steps\)\. Confirm to create/);
});

test('planner adapter symmetrically drops English clarification questions for Chinese request', async () => {
  const review = async () => ({
    outcome: 'clarification_required',
    requiredUserInputs: ['which calendar to operate on', 'max items count'],
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '查詢日曆活動', previousSpec: null });
  assert.equal(r.outcome, 'clarification_required');
  // Mismatched English inputs dropped; localized Chinese default used
  assert.equal(r.assistantMessage, '請提供更明確的需求。');
});

test('planner adapter symmetrically drops Chinese clarification questions for English request', async () => {
  const review = async () => ({
    outcome: 'clarification_required',
    requiredUserInputs: ['欲查詢的日曆名稱', '最大數量'],
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'Query calendar events', previousSpec: null });
  assert.equal(r.outcome, 'clarification_required');
  // Mismatched Chinese inputs dropped; localized English default used
  assert.equal(r.assistantMessage, 'Please provide more specific requirements.');
});

test('planner adapter ensures localized spec.goal is canonical and matches review.plan.goal', async () => {
  const spec = { goal: 'English goal from model', steps: [{}, {}] };
  const planObj = { goal: 'English goal from model', steps: [{}, {}] };
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: spec,
    plan: planObj,
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '抓取代辦事項清單', previousSpec: null });
  // The adapter output spec is the new canonical spec; both spec.goal and plan.goal are updated
  assert.equal(r.spec.goal, '抓取代辦事項清單');
  assert.equal(planObj.goal, '抓取代辦事項清單');
  assert.match(r.assistantMessage, /已規劃：抓取代辦事項清單/);
});

test('resolveFallbackGoal preserves previous canonical goal during refinement rather than clobbering with delta command', () => {
  const prevSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };
  // Turn 2 refinement: user says short delta "改成降序"
  const goal = resolveFallbackGoal('改成降序', prevSpec, 'zh', '依需求規劃的工作流');
  // Must preserve canonical overall goal!
  assert.equal(goal, '抓取使用者 1 的待辦事項並統計未完成數量');

  // English refinement: user says "sort descending", prevSpec has English goal
  const prevEnSpec = { goal: 'Fetch user 1 todos and count incomplete', steps: [{}, {}] };
  const enGoal = resolveFallbackGoal('sort descending', prevEnSpec, 'en', 'Planned workflow');
  assert.equal(enGoal, 'Fetch user 1 todos and count incomplete');
});

test('planner adapter preserves previous canonical goal during refinement when model drifts to wrong language', async () => {
  const prevSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };
  // Turn 2 refinement: user says "改成降序", model returns English goal
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: 'Sort todos descending and count incomplete', steps: [{}, {}, {}] },
    plan: { goal: 'Sort todos descending and count incomplete', steps: [{}, {}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '改成降序', previousSpec: prevSpec });
  // The canonical overall goal is preserved from prevSpec, NOT clobbered by "改成降序"!
  assert.equal(r.spec.goal, '抓取使用者 1 的待辦事項並統計未完成數量');
  assert.match(r.assistantMessage, /^已規劃：抓取使用者 1 的待辦事項並統計未完成數量（3 步）。確認即可建立/);
});

test('formatCapabilityGaps preserves technical IDs while filtering language-mismatched human prose', () => {
  // Chinese request: preserve technical ID 'delivery.telegram', keep Chinese prose, drop English prose
  const zhGaps = formatCapabilityGaps(['delivery.telegram', '不支援外部寫入', 'raw english prose should be dropped'], 'zh', '、');
  assert.equal(zhGaps, 'delivery.telegram、不支援外部寫入');

  // English request: preserve technical ID 'delivery.telegram', keep English prose, drop Chinese prose
  const enGaps = formatCapabilityGaps(['delivery.telegram', 'external writes not supported', '這段中文應被過濾'], 'en', ', ');
  assert.equal(enGaps, 'delivery.telegram, external writes not supported');
});

test('formatCapabilityGaps drops suspicious tokens (e.g. sk-secret) and enforces dotted skill ID grammar', () => {
  // Tokens like 'sk-secret', 'ghp_token', or un-dotted strings are dropped
  const gapsWithSecrets = formatCapabilityGaps(['delivery.telegram', 'sk-ant-api03-secret', 'ghp_myfaketoken', 'not_dotted_id'], 'en', ', ');
  assert.equal(gapsWithSecrets, 'delivery.telegram');

  // Dotted skill IDs are kept
  const validDotted = formatCapabilityGaps(['transform.pivot', 'database.mysql_query'], 'en', ', ');
  assert.equal(validDotted, 'transform.pivot, database.mysql_query');
});

test('formatCapabilityGaps drops human prose carrying embedded secret tokens (unanchored check)', () => {
  // English prose with embedded secret tokens anywhere in the sentence
  const enEmbedded = formatCapabilityGaps([
    'needs sk-ant-api03-secret to operate',
    'please use bearer MY_SECRET_TOKEN_HERE',
    'external writes not supported',
  ], 'en', ', ');
  // Only the clean prose without secrets survives!
  assert.equal(enEmbedded, 'external writes not supported');

  // Chinese prose with embedded secret tokens anywhere in the sentence
  const zhEmbedded = formatCapabilityGaps([
    '需要提供 sk-ant-api03-secret 才能連線',
    '此服務需要 bearer token-value-12345 授權',
    '不支援外部寫入服務',
  ], 'zh', '、');
  // Only the clean Chinese prose without secrets survives!
  assert.equal(zhEmbedded, '不支援外部寫入服務');
});

test('detectLanguage prioritizes explicit language directives over script detection', () => {
  // Explicit English directive in Chinese sentence -> 'en'
  assert.equal(detectLanguage('請用英文規劃這個流程'), 'en');
  assert.equal(detectLanguage('請以英文回答'), 'en');
  assert.equal(detectLanguage('Please respond in English'), 'en');
  assert.equal(detectLanguage('in english please: fetch user 1'), 'en');

  // Explicit Chinese directive in English sentence -> 'zh'
  assert.equal(detectLanguage('用中文回答'), 'zh');
  assert.equal(detectLanguage('respond in Chinese please: fetch user 1'), 'zh');
  assert.equal(detectLanguage('請用繁中說明'), 'zh');

  // Mixed CJK + Latin technical input without directive -> 'zh'
  assert.equal(detectLanguage('抓取 JSONPlaceholder todos 並用 count_false_boolean 統計'), 'zh');
});

test('cross-turn language switching preserves previous macro goal while adapting assistantMessage language', async () => {
  const prevZhSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };

  // Turn 2: User gives English delta "sort descending", model drifts
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: 'Sort todos descending and count incomplete', steps: [{}, {}, {}] },
    plan: { goal: 'Sort todos descending and count incomplete', steps: [{}, {}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: 'sort descending', previousSpec: prevZhSpec });

  // 1. Assistant message preserves Chinese conversation base language for short English delta
  assert.match(r.assistantMessage, /^已規劃：/);
  // 2. Canonical macro goal is preserved, NOT clobbered by "sort descending"
  assert.equal(r.spec.goal, '抓取使用者 1 的待辦事項並統計未完成數量');
});

test('explicit directive in Turn 2 switches assistantMessage language cleanly', async () => {
  const prevZhSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };

  // Turn 2: User types Chinese characters requesting English: "請用英文說明"
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: 'Fetch user 1 todos and summarize', steps: [{}, {}] },
    plan: { goal: 'Fetch user 1 todos and summarize', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '請用英文說明', previousSpec: prevZhSpec });

  // Directive overrides script detection -> assistantMessage is English!
  assert.match(r.assistantMessage, /^Planned: /);
});

test('isDeltaInstruction correctly identifies Chinese and English deltas across spacing and punctuation', () => {
  // Explicit refinement markers are always deltas (even on turn 1)
  assert.equal(isDeltaInstruction('改成降序', false), true);
  assert.equal(isDeltaInstruction('改成 降序', false), true);
  assert.equal(isDeltaInstruction('改成：降序', false), true);
  assert.equal(isDeltaInstruction('加上排序', false), true);
  assert.equal(isDeltaInstruction('移除步驟', false), true);

  // Operation phrases are NOT deltas on Turn 1 (fresh conversation)
  assert.equal(isDeltaInstruction('排序 todos', false), false);
  assert.equal(isDeltaInstruction('限制取前5筆', false), false);
  assert.equal(isDeltaInstruction('sort descending', false), false);

  // Operation phrases ARE deltas in a refinement context (Turn 2+)
  assert.equal(isDeltaInstruction('排序 todos', true), true);
  assert.equal(isDeltaInstruction('限制取前5筆', true), true);
  assert.equal(isDeltaInstruction('sort descending', true), true);
  assert.equal(isDeltaInstruction('limit 10', true), true);

  // Complete macro goals must NOT be classified as deltas
  assert.equal(isDeltaInstruction('抓取使用者 1 的待辦事項並統計未完成數量', false), false);
  assert.equal(isDeltaInstruction('抓取使用者 1 的待辦事項並統計未完成數量', true), false);
  assert.equal(isDeltaInstruction('Fetch user 1 todos and summarize incomplete items', false), false);
});

test('planner adapter preserves meaningful initial goal for fresh conversation (Turn 1) starting with operation phrase', async () => {
  // Turn 1 fresh conversation (previousSpec === null): user asks "排序 todos"
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '排序 todos', steps: [{}, {}] },
    plan: { goal: '排序 todos', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '排序 todos', previousSpec: null });

  // On Turn 1, "排序 todos" is the legitimate macro goal, NOT clobbered with generic default!
  assert.equal(r.spec.goal, '排序 todos');
  assert.match(r.assistantMessage, /^已規劃：排序 todos（2 步）。確認即可建立/);
});

test('planner adapter preserves meaningful initial goal for fresh conversation (Turn 1) starting with 限制', async () => {
  // Turn 1 fresh conversation: user asks "限制取前5筆"
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '限制取前5筆', steps: [{}, {}] },
    plan: { goal: '限制取前5筆', steps: [{}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '限制取前5筆', previousSpec: null });

  // On Turn 1, "限制取前5筆" is preserved as macro goal!
  assert.equal(r.spec.goal, '限制取前5筆');
  assert.match(r.assistantMessage, /^已規劃：限制取前5筆（2 步）。確認即可建立/);
});

test('planner adapter prevents a model-generated Chinese short delta from overwriting prior macro goal', async () => {
  const prevZhSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };

  // Turn 2: User says "改成降序", model emits a Chinese short delta as goal: "改成降序"
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '改成降序', steps: [{}, {}, {}] },
    plan: { goal: '改成降序', steps: [{}, {}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '改成降序', previousSpec: prevZhSpec });

  // isDeltaInstruction catches Chinese delta without word boundary!
  // Preserves prior macro goal instead of clobbering with "改成降序"
  assert.equal(r.spec.goal, '抓取使用者 1 的待辦事項並統計未完成數量');
  assert.match(r.assistantMessage, /^已規劃：抓取使用者 1 的待辦事項並統計未完成數量（3 步）。確認即可建立/);
});

test('planner adapter handles Chinese delta with mixed punctuation and spacing correctly', async () => {
  const prevZhSpec = { goal: '抓取使用者 1 的待辦事項並統計未完成數量', steps: [{}, {}] };

  // Turn 2: User says "改成：降序", model echoes "改成：降序"
  const review = async () => ({
    outcome: 'ready_to_compile',
    specification: { goal: '改成：降序', steps: [{}, {}, {}] },
    plan: { goal: '改成：降序', steps: [{}, {}, {}] },
  });
  const plan = createPlannerAdapter(review);
  const r = await plan({ message: '改成：降序', previousSpec: prevZhSpec });

  assert.equal(r.spec.goal, '抓取使用者 1 的待辦事項並統計未完成數量');
  assert.match(r.assistantMessage, /^已規劃：抓取使用者 1 的待辦事項並統計未完成數量（3 步）。確認即可建立/);
});
