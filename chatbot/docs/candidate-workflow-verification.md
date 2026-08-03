# Candidate Workflow Verification

`verifyCandidateWorkflow(input, options)` is the shared verification boundary
for any producer of a complete n8n workflow candidate. It does not select a
model, require a node type, or mutate a workflow in n8n.

## Input

```js
{
  operation: 'create' | 'modify' | 'insert' | 'delete',
  userRequest: 'original user request',
  candidateWorkflow: { /* complete workflow */ } | '{ /* JSON text */ }',
  acceptanceContract: {
    // Optional. A non-empty list returns `clarify` without guessing values.
    requiredUserInputs: [{ question: '...' }]
  }
}
```

`options` supplies environment integration rather than producer policy:

```js
{
  n8nBaseUrl,
  n8nApiKey,
  structuralValidator, // optional test adapter
  semanticReview,      // optional async reviewer callback
}
```

## Output

```js
{
  status: 'pass' | 'repair' | 'clarify' | 'warning',
  workflow,       // normalized complete workflow after structural success
  errors: [],     // objective repair/clarification findings
  warnings: [],   // advisory findings
  verification: {
    operation,
    structural: { status },
    dataflow: { status, errors, summary },
    semantic: { status, issues, warnings, repairInstruction }
  }
}
```

Verification order is structural normalization and runtime-schema validation,
connection type/port validation, Code named-node dataflow validation, then
semantic review. Runtime and dataflow failures return `repair` before the
reviewer is called. A semantic dataflow claim contradicted by verified
dataflow is downgraded to a warning. Reviewer availability is advisory and
cannot invalidate an otherwise verified candidate.

Create currently calls this boundary with `operation: 'create'`. An Edit
producer only needs to pass its final complete candidate to the same function
and provide its existing semantic-review callback if it has one.
