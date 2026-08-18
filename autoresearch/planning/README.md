# Runtime-Aware Planning

`runtimeSchemaCatalog.js` is the read-only retrieval layer for the planned
description -> planner -> contract -> generator experiment. It turns the
installed n8n runtime export into a small, deterministic node allowlist for a
single user request. The catalog does not call a model, n8n, or the network.

The old Easy-100 assistant workflows remain useful only as historical topology
references. Their user descriptions are the inputs for the new experiment;
the planner must target the installed runtime export rather than copy stale
node versions or parameter shapes.
