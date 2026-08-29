@echo off
REM A2A validator launcher (Windows). Fixes the broken for-loop reported by
REM Codex 2026-08-28 (codex-20260828T055236Z-003): the previous version put
REM "py -3" inside a FOR set, so cmd treated the argument as part of the path.
REM A2A_PYTHON is now checked FIRST, which was the case Codex actually tested.
REM Usage: a2a.cmd --check | --digest | --next claude | --locks
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%validate_a2a.py"

if defined A2A_PYTHON (
  "%A2A_PYTHON%" "%SCRIPT%" %*
  exit /b %errorlevel%
)

py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 (
  py -3 "%SCRIPT%" %*
  exit /b %errorlevel%
)

python -c "import sys" >nul 2>&1
if not errorlevel 1 (
  python "%SCRIPT%" %*
  exit /b %errorlevel%
)

python3 -c "import sys" >nul 2>&1
if not errorlevel 1 (
  python3 "%SCRIPT%" %*
  exit /b %errorlevel%
)

>&2 echo [a2a] No usable Python found.
>&2 echo [a2a] Set A2A_PYTHON to the full interpreter path, then retry:
>&2 echo [a2a]   set "A2A_PYTHON=C:\Path\To\python.exe"
>&2 echo [a2a]   a2a\a2a.cmd --check
exit /b 127
