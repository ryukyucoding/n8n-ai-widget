#!/bin/sh
# A2A validator 啟動器（POSIX）。用法: ./a2a.sh --check | --digest | --next claude
HERE="$(cd "$(dirname "$0")" && pwd)"
for P in "$A2A_PYTHON" python3 python; do
  [ -n "$P" ] || continue
  if command -v "$P" >/dev/null 2>&1 || [ -x "$P" ]; then
    exec "$P" "$HERE/validate_a2a.py" "$@"
  fi
done
echo "[a2a] 找不到可用的 Python。請設定 A2A_PYTHON 指向直譯器完整路徑。" >&2
exit 127
