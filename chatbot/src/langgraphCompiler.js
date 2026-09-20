const crypto = require('node:crypto');
const {
  StateGraph,
  Annotation,
  MemorySaver,
  START,
  END,
} = require('@langchain/langgraph');
const { compileNodewiseSpecification } = require('./nodewiseCompiler');
const { verifyCandidateWorkflow } = require('./candidateWorkflowVerifier');
const { initDatabase, SqliteCheckpointer } = require('./sqliteCheckpointer');
const { fetchAndSanitizeWorkflow } = require('./workflowReadback');
const { defaultProductValidator } = require('./productN8nMcpValidator');

let DiscoveryHistoryRecorder;
try {
  const dh = require('../../n8n-node-catalog/discovery_history');
  DiscoveryHistoryRecorder = dh.DiscoveryHistoryRecorder;
} catch {
  DiscoveryHistoryRecorder = null;
}

let historyRecorderInstance = null;
function getHistoryRecorder() {
  if (historyRecorderInstance) return historyRecorderInstance;
  if (DiscoveryHistoryRecorder) {
    try {
      historyRecorderInstance = new DiscoveryHistoryRecorder();
    } catch {
      historyRecorderInstance = null;
    }
  }
  return historyRecorderInstance;
}

const CompilerState = Annotation.Root({
  sessionId: Annotation(),
  specification: Annotation(),
  planFingerprint: Annotation(),
  workflowId: Annotation(),
  parentRunId: Annotation(),
  state: Annotation(),
  compiledWorkflow: Annotation(),
  staticVerification: Annotation(),
  readbackEvidence: Annotation(),
  mcpValidation: Annotation(),
  runId: Annotation(),
});

function getDefaultCheckpointer() {
  try {
    const db = initDatabase();
    if (db) {
      return new SqliteCheckpointer(db);
    }
  } catch {}
  return new MemorySaver();
}

function buildCompilerGraph(checkpointer = getDefaultCheckpointer(), options = {}) {
  const readbackFn = options.readbackFn || fetchAndSanitizeWorkflow;

  const graph = new StateGraph(CompilerState)
    .addNode('compile', (state) => ({
      state: 'compiled',
      compiledWorkflow: compileNodewiseSpecification(state.specification),
    }))
    .addNode('verify_oracle', async (state) => {
      const pythonBin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      const staticVerification = await verifyCandidateWorkflow({
        operation: 'create',
        userRequest: state.compiledWorkflow.name,
        candidateWorkflow: state.compiledWorkflow,
      }, { n8nBaseUrl: null, n8nApiKey: null, python: pythonBin });

      if (!['pass', 'warning'].includes(staticVerification.status)) {
        throw new Error('compiled_workflow_static_verification_failed');
      }

      // Run read-only product n8n-MCP structural validation adapter
      const mcpValidation = defaultProductValidator.validateCandidate(state.compiledWorkflow);

      return { state: 'verified', staticVerification, mcpValidation };
    })
    .addNode('readback_oracle', async (state) => {
      if (!state.workflowId) {
        return { readbackEvidence: null };
      }
      try {
        const evidence = await readbackFn(state.workflowId, options.readbackOptions);
        return { readbackEvidence: evidence };
      } catch (err) {
        return {
          readbackEvidence: {
            status: 'readback_failed',
            workflowId: state.workflowId,
            error: err.message || 'readback_failed',
          },
        };
      }
    })
    .addEdge(START, 'compile')
    .addEdge('compile', 'verify_oracle')
    .addEdge('verify_oracle', 'readback_oracle')
    .addEdge('readback_oracle', END);

  return graph.compile({ checkpointer });
}

const compilerApp = buildCompilerGraph();

async function runLangGraphCompilation({ specification, planFingerprint, sessionId, workflowId, parentRunId }) {
  if (!sessionId) throw new Error('sessionId is required for LangGraph checkpointing');
  if (!specification || typeof specification !== 'object') {
    throw new Error('specification is required for LangGraph compilation');
  }

  const startTime = Date.now();
  const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const config = { configurable: { thread_id: sessionId } };
  const snapshot = await compilerApp.getState(config);
  const previous = snapshot && snapshot.values ? snapshot.values : {};

  if (previous.planFingerprint && previous.planFingerprint !== planFingerprint) {
    throw new Error('checkpoint_plan_fingerprint_mismatch');
  }

  // If already compiled & verified, and no new workflowId requested that wasn't previously read, return resumed
  if (previous.state === 'verified') {
    if (!workflowId || (previous.workflowId === workflowId && previous.readbackEvidence)) {
      return { ...previous, resumed: true, threadId: sessionId };
    }
  }

  const result = await compilerApp.invoke({
    sessionId,
    specification,
    planFingerprint,
    workflowId: workflowId || null,
    parentRunId: parentRunId || null,
    runId,
    state: 'pending',
  }, config);

  const durationMs = Date.now() - startTime;

  // Record sanitized discovery history safely; fail-closed against mutation, fail-safe against throwing
  try {
    const recorder = getHistoryRecorder();
    if (recorder) {
      const specStr = JSON.stringify(specification);
      const specHash = crypto.createHash('sha256').update(specStr).digest('hex');
      recorder.recordRun({
        runId,
        parentRunId: parentRunId || null,
        taskId: sessionId,
        candidateId: `cand-${planFingerprint.slice(0, 12)}`,
        specHash,
        policyHash: 'policy-nodewise-v1',
        compilerRevision: 'nodewiseCompiler:1.0',
        catalogRevision: 'catalog:1.0.0',
        decision: 'compiled_not_created',
        runtimeEvidenceCls: result.readbackEvidence?.status || result.staticVerification?.status || 'pass',
        outcome: result.state || 'verified',
        latencyMs: durationMs,
        promptTokens: 0,
        completionTokens: 0,
      });
    }
  } catch (recErr) {
    // Discovery recorder failures must never fail or alter the compiler result
    console.warn('[discovery_history] failed to record run:', recErr.message || recErr);
  }

  return { ...result, runId, resumed: false, threadId: sessionId };
}

module.exports = { buildCompilerGraph, runLangGraphCompilation };