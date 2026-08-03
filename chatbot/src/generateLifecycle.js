'use strict';

class GenerateStageError extends Error {
  constructor(stage, message, cause) {
    super(message);
    this.name = 'GenerateStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

function abortError(stage) {
  return new GenerateStageError(stage, `generation cancelled before ${stage}`);
}

function ensureActive(signal, stage) {
  if (signal?.aborted) throw abortError(stage);
}

async function runTimedStage({ stage, timeoutMs, signal, emit, task }) {
  ensureActive(signal, stage);
  emit(`${stage}_started`);
  let timer;
  let onAbort;
  const stageController = new AbortController();
  const abortStage = () => {
    if (!stageController.signal.aborted) stageController.abort();
  };
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => task(stageController.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortStage();
          reject(new GenerateStageError(stage, `${stage} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        onAbort = () => {
          abortStage();
          reject(abortError(stage));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    ensureActive(signal, stage);
    emit(`${stage}_completed`);
    return result;
  } catch (error) {
    if (error instanceof GenerateStageError) throw error;
    throw new GenerateStageError(stage, `${stage} failed: ${error.message || String(error)}`, error);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function runGenerateLifecycle({ signal, emit, timeouts, planner, generator, verifier, createWorkflow, postActionVerify }) {
  emit('request_received');
  const plan = await runTimedStage({ stage: 'planning', timeoutMs: timeouts.planningMs, signal, emit, task: planner });
  const workflow = await runTimedStage({ stage: 'generation', timeoutMs: timeouts.generationMs, signal, emit, task: generator });
  const verified = await runTimedStage({ stage: 'structural_validation', timeoutMs: timeouts.verificationMs, signal, emit, task: () => verifier(workflow) });
  ensureActive(signal, 'n8n_create');
  const created = await runTimedStage({ stage: 'n8n_create', timeoutMs: timeouts.n8nCreateMs, signal, emit, task: () => createWorkflow(verified) });
  const postAction = await runTimedStage({ stage: 'post_action_verification', timeoutMs: timeouts.postActionMs, signal, emit, task: () => postActionVerify(created) });
  emit('completed');
  return { plan, workflow: verified, created, postAction };
}

module.exports = { GenerateStageError, runTimedStage, runGenerateLifecycle };
