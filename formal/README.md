# Formal Chatbot Deployment

This deploys the `codex/runtime-compiler-integration` code into the existing
formal `n8n-chatbot-1` service. It preserves the original Create and Edit UI
modes and adds a third `Compiler Beta` mode.

It does not modify the `ollama-widget` branch, restart n8n, or use the
standalone beta container. Before replacement it builds a candidate image and
runs the focused tests. It recreates every Docker network and network alias
used by the existing chatbot, including the public widget proxy route. The
previous chatbot image receives a rollback tag and the previous container is
kept stopped under a timestamped rollback name. If the new container does not
pass health, mode, or public `widget.js` checks, the script restores the
previous container automatically.

Run on the .44 server only after the feature branch has been fetched into the
runtime compiler worktree:

```bash
cd /data/daniel/n8n-worktrees/runtime-compiler-integration
git fetch origin codex/runtime-compiler-integration
git checkout --detach FETCH_HEAD
bash formal/deployRuntimeCompilerToProductionOn44.sh
```

After deployment, refresh the regular n8n chatbot widget. It should show:

1. `建立 workflow` using the existing fine-tuned Create model.
2. `Compiler Beta` for the two verified deterministic public-data patterns.
3. `插入／刪除／修改` using the existing Edit flow.

The Compiler Beta must reject unsupported requests instead of falling back to
the fine-tuned model.
