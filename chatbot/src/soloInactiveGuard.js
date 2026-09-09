'use strict';

// Post-create inactive guarantee for the solo Calendar skill (fail-closed).
// createVerifiedCompilerWorkflow -> sanitizeCreateWorkflowPayload() strips the
// root `active` field, so the skeleton's active:false is NOT sent to n8n. We must
// not merely CLAIM inactive:
//   - trust an explicit `active:false` create response (safe, no API calls);
//   - otherwise the workflow needs action, which requires a VALID id: if the id
//     is missing/malformed we cannot verify OR remove it -> explicit operator
//     escalation (`unmanageable`), never a silent orphan or a path built from a
//     malformed id;
//   - with a valid id: deactivate + READBACK to verify, returning the verified
//     workflow; if inactivity still can't be confirmed, DELETE the workflow
//     (orphan prevention), distinguishing deleted vs cleanup-failed.
// deactivate/getWorkflow/deleteWorkflow are injected for unit-testing.

function isConfirmedInactive(created) {
  return Boolean(created) && created.active === false;
}

// n8n workflow ids are short scalar tokens; reject anything else BEFORE it is
// interpolated into an API path.
function isValidWorkflowId(id) {
  return (typeof id === 'string' || typeof id === 'number')
    && /^[A-Za-z0-9_-]{1,128}$/.test(String(id));
}

async function enforceInactiveDraft({ created, deactivate, getWorkflow, deleteWorkflow }) {
  // 1. A usable success requires a valid, addressable id — even for an inactive
  //    create. Missing/malformed id => the resource cannot be addressed, verified,
  //    linked (/workflow/undefined), or deleted => operator escalation, and NO id
  //    is ever interpolated into an API path.
  const id = created && created.id;
  if (!isValidWorkflowId(id)) {
    const e = new Error('created workflow has no usable id; cannot address, verify, or remove');
    e.unmanageable = true;
    throw e;
  }

  // 2. With a valid id, trust an explicit inactive create response (no API calls).
  if (created.active === false) {
    return { ok: true, workflow: created, active: false, deactivated: false };
  }

  // 3. Establish + VERIFY inactivity by readback; delete if we cannot confirm.
  let deactivated = false;
  try {
    if (created.active === true) { await deactivate(id); deactivated = true; }
    let wf = await getWorkflow(id);
    if (wf && wf.active === true) { await deactivate(id); deactivated = true; wf = await getWorkflow(id); }
    if (!wf || wf.active !== false) throw new Error('inactive_unconfirmed');
    return { ok: true, workflow: wf, active: false, deactivated };
  } catch (err) {
    try {
      await deleteWorkflow(id);
    } catch (delErr) {
      const e = new Error(`inactive_unconfirmed_and_cleanup_failed:${id}`);
      e.cleanupFailed = true;
      e.workflowId = id;
      e.cause = delErr;
      throw e;
    }
    const e = new Error(`inactive_unconfirmed_workflow_deleted:${id}`);
    e.deleted = true;
    e.workflowId = id;
    throw e;
  }
}

// Route-level post-create finalizer (testable without a live server). Passes
// through non-200 create results unchanged; otherwise enforces the inactive
// guarantee and maps failures to explicit response codes.
async function finalizeSoloCreate({ result, deactivate, getWorkflow, deleteWorkflow }) {
  if (!result || result.status !== 200) return result;
  try {
    const guard = await enforceInactiveDraft({
      created: result.payload && result.payload.workflow,
      deactivate,
      getWorkflow,
      deleteWorkflow,
    });
    return {
      status: 200,
      payload: { ...result.payload, workflow: guard.workflow, inactiveConfirmed: true, deactivated: guard.deactivated },
    };
  } catch (e) {
    if (e.unmanageable) {
      return { status: 500, payload: { error: 'A workflow may have been created but has no usable id to verify or remove; please check n8n and delete any unintended workflow.', code: 'solo_created_unmanageable' } };
    }
    if (e.cleanupFailed) {
      return { status: 500, payload: { error: `Created workflow could not be confirmed inactive and cleanup failed (id ${e.workflowId}); please remove it in n8n.`, code: 'solo_inactive_orphan_cleanup_failed', workflowId: e.workflowId } };
    }
    return { status: 500, payload: { error: 'Created workflow could not be confirmed inactive; it was removed. Please retry.', code: 'solo_inactive_unconfirmed' } };
  }
}

// Solo-owned create orchestrator. Unlike createVerifiedCompilerWorkflow (shared),
// this RETAINS the created object (with id) through post-create handling, so any
// failure after a successful create can still clean up. It deliberately does NOT
// run a throwing post-create verifier — the readback inside enforceInactiveDraft
// IS the verification, and it owns cleanup. Everything is injected for testing.
async function createAndFinalizeSoloWorkflow({
  skeleton,
  metadata = {},
  publicUrl = 'http://localhost:5678',
  message = 'Solo skill workflow created; connect your credential in n8n and activate it.',
  staticVerify,
  createWorkflow,
  deactivate,
  getWorkflow,
  deleteWorkflow,
}) {
  const verification = await staticVerify(skeleton);
  if (!verification || !['pass', 'warning'].includes(verification.status)) {
    return { status: 422, payload: { error: 'Runtime Compiler Beta workflow verification failed.', code: 'beta_static_verification_failed' } };
  }
  let created;
  try {
    created = await createWorkflow(verification.workflow || skeleton);
  } catch (err) {
    // Create attempt failed (or a 2xx body we could not parse to an id): no
    // addressable resource to clean. Operator should check n8n if uncertain.
    return { status: 500, payload: { error: 'Runtime Compiler Beta could not create the workflow.', code: 'beta_create_failed' } };
  }
  const id = created && created.id;
  const result = {
    status: 200,
    payload: {
      message,
      workflowId: id,
      workflowName: created && created.name,
      workflowUrl: isValidWorkflowId(id) ? `${publicUrl}/workflow/${id}` : undefined,
      workflow: created,
      ...metadata,
    },
  };
  // finalizeSoloCreate -> enforceInactiveDraft owns readback verification + cleanup.
  return finalizeSoloCreate({ result, deactivate, getWorkflow, deleteWorkflow });
}

module.exports = { isConfirmedInactive, isValidWorkflowId, enforceInactiveDraft, finalizeSoloCreate, createAndFinalizeSoloWorkflow };
