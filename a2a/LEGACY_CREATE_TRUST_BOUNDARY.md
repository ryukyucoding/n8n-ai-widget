# Legacy `/generate` Trust Boundary

**Status:** independently confirmed code-level architecture finding; deployment
configuration and actual client-mode use remain unverified.

**Reviewed revision context:** `codex/autoresearch-a2a@243954d`

**Not a deployment authorization, security exploit claim, or product-code change.**

## 1. Confirmed dispatch behavior

`chatbot/src/index.js` routes `POST /generate` by `req.body.mode`:

| Request mode | Route / trust model |
| --- | --- |
| `plan_first_request` | constrained planner → review result; no workflow creation |
| `plan_first_approve` | HMAC-bound approval flow |
| `plan_first_compile` | approved nodewise specification → deterministic compiler → static verifier → create adapter |
| `compiler_beta` | named, limited public-data pattern compiler |
| absent or any other mode | legacy LLM workflow JSON generation and create path |

The first three plan-first modes are guarded by the plan-first availability
configuration and approval binding. The unmatched/default path invokes the
legacy Create model, then calls `verifyCandidateWorkflow`, and—when the server
n8n API key is configured—creates a workflow through the server-side create
adapter.

Therefore the following claim is accurate at the code level:

> The runtime-aware nodewise compiler is connected but opt-in. It is not the
> default `/generate` trust surface.

## 2. What this does and does not mean

### It means

- A client that omits `mode`, uses an unknown `mode`, or intentionally selects
  legacy create bypasses plan-first review, HMAC approval binding, nodewise
  source-schema binding, and the deterministic compiler.
- The project must not describe all workflows produced by `/generate` as if
  they received the runtime-aware compiler's guarantees.
- A user-facing mode label/default and server-side dispatch behavior are part
  of the research trust model, not merely UI detail.

### It does not mean

- Legacy create has no protections. It has its own candidate verifier,
  acceptance/semantic-review paths, retry/repair behavior, sanitized create
  payload, and readback verification.
- This review proves the deployed environment currently enables plan-first or
  that users currently omit/select a particular mode. Those are private runtime
  facts Desktop Codex/.44 and Dan must verify.
- This record authorizes removing legacy create, changing the default mode,
  deploying a change, or treating the condition as a confirmed external
  exploit.

## 3. Classification

This is a **research/product trust-boundary gap**:

```text
implemented and connected ≠ default user path
```

It belongs in architecture/product evidence, not `a2a/ORGANIZATION.md`, which
defines people, authority, and quota allocation rather than route semantics.

The gap is material because the active research goal is to let non-expert users
create executable workflows with natural language. If the ordinary user path
silently falls back to legacy direct generation, results can be governed by a
different safety/correctness model than the runtime-aware research claim.

## 4. Required private evidence

Desktop Codex/.44 should return sanitized answers to:

1. Is plan-first enabled in the deployed test environment?
2. What mode does the current widget send by default for a typical create
   interaction?
3. Can a user explicitly select legacy mode, plan-first mode, or both?
4. Are unexpected/unknown modes rejected by the client, server, or neither?
5. Which route created the accepted Mapping v1 fixture?

Return route/mode categories and revision only; do not include private host,
credential, raw log, or session details.

## 5. Decision options for Dan after evidence

| Option | Meaning | Tradeoff |
| --- | --- | --- |
| A. Plan-first is default for supported requests | Ordinary supported creation gets the compiler trust model; legacy remains an explicit compatibility mode | Requires clear capability-gap UX and transition testing |
| B. Keep both modes explicit and clearly labeled | User chooses legacy vs plan-first with trust/capability explanation | More UI complexity; non-experts may choose the wrong mode |
| C. Keep legacy as default temporarily | Preserves legacy behavior while beta develops | Must state that default create does not carry plan-first guarantees |

No option should be selected by an agent. Evidence first, then Dan decides.

## 6. Immediate rule for reporting

Until Dan chooses and deployment evidence confirms a route default:

- report plan-first results as `plan-first/nodewise` results only;
- report legacy `/generate` results as a separate baseline/trust path;
- do not aggregate their success, verification, or safety claims;
- preserve the distinction in future demos, acceptance records, and promotion
  packets.
