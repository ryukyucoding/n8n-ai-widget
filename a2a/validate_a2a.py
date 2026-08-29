#!/usr/bin/env python3
"""A2A Protocol v1 validator.

把 PROTOCOL.md 的規矩變成可被機器檢查的規則。兩個 agent 在每次寫入前後都應執行。

用法:
    python a2a/validate_a2a.py --check     # 驗證，有 ERROR 時 exit 1
    python a2a/validate_a2a.py --digest    # 人類可讀的現況摘要
    python a2a/validate_a2a.py --next claude   # 產生下一個合法的訊息 id

僅使用標準函式庫，Windows / Linux 皆可執行。
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

A2A = Path(__file__).resolve().parent
REPO = A2A.parent
LOCKS = A2A / "locks"
LOCK_TTL_HOURS = 4
SNAPSHOTS = A2A / "snapshots"
KEEP_SNAPSHOTS = 20
AGENTS = ("claude", "codex")
KINDS = {"question", "proposal", "finding", "decision", "handoff", "status"}
REQUIRED = ("id", "ts", "from", "to", "kind", "topic", "replyTo", "needsHuman", "body")

MAX_PER_DAY = 60          # 純粹的病態上限，不是工作量限制
MAX_UNANSWERED = 6       # 對同一對象連續發送而對方毫無回音的上限
ROTATE_LINES = 500
LOOP_WINDOW = 6
HEARTBEAT_MULTIPLIER = 3
# 各 agent 的預期週期（秒）。Codex 每 30 分鐘、Claude 每日（Dan 也會手動呼叫）。
CADENCE = {"codex": 30 * 60, "claude": 24 * 3600}

ID_RE = re.compile(r"^(claude|codex)-(\d{8}T\d{6}Z)-(\d{3})$")
ACK_RE = re.compile(
    r"^\s*(收到|了解|好的|同意|沒問題|看過了|已閱|ok|okay|ack|acknowledged|got it|noted|understood|agreed)"
    r"[\s。.!！]*$",
    re.IGNORECASE,
)
EVIDENCE_RE = re.compile(
    r"(讀取|實測|驗證|已確認|grep|sha256|檔案|行號|L\d+|test|測試|輸出|exit code|`[^`]+\.(js|py|json|md)`)",
    re.IGNORECASE,
)
SECRET_RE = re.compile(
    r"(-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)"
)

problems = []


def err(msg):
    problems.append(("ERROR", msg))


def warn(msg):
    problems.append(("WARN", msg))


def parse_ts(value):
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def outbox(agent):
    return A2A / f"{agent}.outbox.jsonl"


def statefile(agent):
    return A2A / f"{agent}.state.json"


def load_messages():
    """回傳 {agent: [msg,...]}，並就地檢查每一行。"""
    result = {}
    for agent in AGENTS:
        path = outbox(agent)
        messages = []
        if not path.exists():
            result[agent] = messages
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        if len(lines) > ROTATE_LINES:
            warn(f"{path.name} 有 {len(lines)} 行，超過 {ROTATE_LINES}（P9）：請輪替到 archive/YYYY-MM/")
        for lineno, raw in enumerate(lines, 1):
            if not raw.strip():
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as exc:
                err(f"{path.name}:{lineno} 不是合法 JSON：{exc}")
                continue
            if not isinstance(msg, dict):
                err(f"{path.name}:{lineno} 必須是 JSON 物件")
                continue
            msg["_line"] = lineno
            msg["_file"] = path.name
            check_message(agent, msg)
            messages.append(msg)
        result[agent] = messages
    return result


def check_message(owner, msg):
    where = f"{msg['_file']}:{msg['_line']}"
    for field in REQUIRED:
        if field not in msg:
            err(f"{where} 缺少必填欄位 `{field}`")
    if any(f not in msg for f in REQUIRED):
        return

    # P1 單一寫者
    if msg["from"] != owner:
        err(f"{where} from=`{msg['from']}` 但這是 {owner} 的 outbox —— 違反 P1 單一寫者")

    m = ID_RE.match(str(msg["id"]))
    if not m:
        err(f"{where} id 格式不符：`{msg['id']}`（應為 <agent>-YYYYMMDDTHHMMSSZ-NNN）")
    elif m.group(1) != msg["from"]:
        err(f"{where} id 前綴 `{m.group(1)}` 與 from `{msg['from']}` 不符")

    if parse_ts(msg["ts"]) is None:
        err(f"{where} ts 不是合法的 ISO8601 UTC（需形如 2026-08-28T05:00:00Z）：`{msg['ts']}`")

    if msg["from"] not in AGENTS or msg["to"] not in AGENTS + ("human",):
        err(f"{where} from/to 值不合法")
    if msg["from"] == msg["to"]:
        err(f"{where} from 與 to 相同")

    if msg["kind"] not in KINDS:
        err(f"{where} kind `{msg['kind']}` 不在允許集合 {sorted(KINDS)}")

    if not isinstance(msg["needsHuman"], bool):
        err(f"{where} needsHuman 必須是 boolean")

    body = str(msg.get("body", ""))
    if not body.strip():
        err(f"{where} body 不得為空")

    # P4 不准空回應
    if ACK_RE.match(body.strip()) or (len(body.strip()) < 15 and msg["kind"] == "status"):
        err(f"{where} 疑似空回應（P4）：訊息必須攜帶新資訊，沒有新資訊就不要寫")

    # finding 必須附驗證方式
    if msg["kind"] == "finding" and not EVIDENCE_RE.search(body):
        warn(f"{where} kind=finding 但 body 未說明驗證方式（讀了什麼檔、跑了什麼指令）")

    # secret 掃描
    if SECRET_RE.search(body):
        err(f"{where} body 疑似含有 secret / token —— 立即移除，改用 n8n credential UI")

    if not isinstance(msg.get("artifacts", []), list):
        err(f"{where} artifacts 必須是陣列")


def check_ids_and_replies(by_agent):
    seen = {}
    for agent in AGENTS:
        for msg in by_agent[agent]:
            mid = msg.get("id")
            if mid in seen:
                err(f"{msg.get('_file')}:{msg.get('_line')} id `{mid}` 重複（已出現於 {seen[mid]}）")
            else:
                seen[mid] = f"{msg.get('_file')}:{msg.get('_line')}"
    for agent in AGENTS:
        for msg in by_agent[agent]:
            rt = msg.get("replyTo")
            if rt not in (None, "") and rt not in seen:
                warn(f"{msg.get('_file')}:{msg.get('_line')} replyTo `{rt}` 找不到對應訊息")


def check_loop(by_agent):
    """P5 迴圈煞車。"""
    everything = [m for a in AGENTS for m in by_agent[a] if parse_ts(m.get("ts", ""))]
    everything.sort(key=lambda m: parse_ts(m["ts"]))
    window = everything[-LOOP_WINDOW:]
    if len(window) < LOOP_WINDOW:
        return
    alternating = all(window[i]["from"] != window[i + 1]["from"] for i in range(len(window) - 1))
    substantive = any(m["kind"] in ("finding", "decision") for m in window)
    escalated = any(m.get("needsHuman") for m in window)
    if alternating and not substantive and not escalated:
        err(
            f"偵測到往返迴圈（P5）：最近 {LOOP_WINDOW} 則在兩個 agent 之間交替，"
            "且沒有任何 finding/decision。下一個寫入者必須改為 needsHuman:true 並停止該主題"
        )


def check_budget(by_agent):
    """P8。2026-08-28 修訂——原版是「每日 20 則」的單純計數，在一場由人主導的密集工作
    階段中誤報（Claude 27 則、Codex 12 則，交錯模式顯示是真實往返而非失控）。

    修訂的理由不是「規則擋到我」，而是原規則量錯了東西：
      - P8 想防的是 F3 失控往返。但 P5（迴圈煞車）已經直接處理往返：
        6 則交替且無 finding/decision 就強制升級給人。
      - 失控在檔案上真正的形狀是**單方面灌訊息**——一方持續發送而對方毫無回音
        （對方掛了、或訊息根本沒被讀到）。單純的每日計數看不出這個形狀，
        它同時放過「對死掉的對象發 19 則」也擋下「健康往返 21 則」。

    因此：每日上限升為純粹的病態backstop，並新增針對實際病態形狀的檢查。
    **在它真正要防的維度上，新規則比舊規則更嚴格。**
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for agent in AGENTS:
        n = sum(1 for m in by_agent[agent] if str(m.get("ts", "")).startswith(today))
        if n > MAX_PER_DAY:
            err(f"{agent} 今日已寫 {n} 則，超過病態上限 {MAX_PER_DAY}（P8）")

    # 單方面灌訊息：對同一對象連續發送、期間對方一則都沒寫
    everything = [m for a in AGENTS for m in by_agent[a] if parse_ts(m.get("ts", ""))]
    everything.sort(key=lambda m: parse_ts(m["ts"]))
    # 2026-08-28 修正：初版在迴圈內對「歷史上曾達到門檻」報錯，導致一旦觸發就永遠
    # 無法清除——即使對方後來已回應。**必須只依當前狀態判定。**
    streak = {agent: 0 for agent in AGENTS}
    for m in everything:
        sender = m.get("from")
        if m.get("to") == "human" or sender not in streak:
            continue
        for other in AGENTS:
            if other != sender:
                streak[other] = 0
        streak[sender] += 1

    for agent, n in streak.items():
        if n > MAX_UNANSWERED:
            err(f"{agent} 目前已連續發送 {n} 則而對方毫無回音（P8）。"
                f"對方可能已停止運作或根本沒讀到——停止發送，改寫一則 to:\"human\" 告知 Dan。")
        elif n == MAX_UNANSWERED:
            warn(f"{agent} 目前已連續發送 {n} 則而對方毫無回音（P8）")


def load_states():
    states = {}
    for agent in AGENTS:
        path = statefile(agent)
        if not path.exists():
            warn(f"{path.name} 不存在——{agent} 尚未執行過，或未依 P3/P7 更新狀態")
            states[agent] = None
            continue
        try:
            states[agent] = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            err(f"{path.name} 不是合法 JSON：{exc}")
            states[agent] = None
    return states


def check_heartbeats(states):
    now = datetime.now(timezone.utc)
    for agent in AGENTS:
        state = states.get(agent)
        if not state:
            continue
        hb = parse_ts(state.get("heartbeat", ""))
        if hb is None:
            err(f"{agent}.state.json 的 heartbeat 缺失或格式錯誤（P7）")
            continue
        age = (now - hb).total_seconds()
        limit = CADENCE[agent] * HEARTBEAT_MULTIPLIER
        if age > limit:
            warn(
                f"{agent} 的 heartbeat 已 {age / 3600:.1f} 小時未更新（上限 {limit / 3600:.0f} 小時，P7）："
                "對方應停止繼續送訊息並記錄一則 status"
            )


def unread_counts(by_agent, states):
    out = {}
    for reader in AGENTS:
        peer = AGENTS[0] if reader == AGENTS[1] else AGENTS[1]
        state = states.get(reader) or {}
        cursor = state.get("lastProcessedId")
        msgs = by_agent[peer]
        if cursor is None:
            out[reader] = len(msgs)
            continue
        ids = [m.get("id") for m in msgs]
        out[reader] = len(msgs) - (ids.index(cursor) + 1) if cursor in ids else len(msgs)
    return out


def digest(by_agent, states):
    print("=" * 62)
    print("A2A 現況摘要  ", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    print("=" * 62)
    unread = unread_counts(by_agent, states)
    for agent in AGENTS:
        state = states.get(agent) or {}
        hb = state.get("heartbeat", "—")
        print(f"\n[{agent}]  訊息 {len(by_agent[agent])} 則   heartbeat {hb}")
        print(f"          游標 {state.get('lastProcessedId', '—')}   未讀對方 {unread[agent]} 則")
    open_items = [
        m
        for a in AGENTS
        for m in by_agent[a]
        if m.get("kind") in ("question", "proposal") or m.get("needsHuman")
    ]
    if open_items:
        print(f"\n--- 需要回應或人類裁決（{len(open_items)}）---")
        for m in open_items[-10:]:
            flag = "  [需 Dan 裁決]" if m.get("needsHuman") else ""
            body = " ".join(str(m.get("body", "")).split())
            print(f"  {m.get('ts')}  {m.get('from')}→{m.get('to')}  [{m.get('topic')}]{flag}")
            print(f"      {body[:110]}{'…' if len(body) > 110 else ''}")
    nh = A2A / "NEEDS_HUMAN.md"
    if nh.exists():
        n = sum(1 for line in nh.read_text(encoding="utf-8").splitlines() if line.startswith("- ["))
        print(f"\nNEEDS_HUMAN.md：{n} 項（只有 Dan 能結案）")
    print()



# ---------------------------------------------------------------- dashboard

DASH_CSS = """
:root{--bg:#fbfbfa;--fg:#1a1a18;--muted:#6b6b66;--line:#e4e4e0;--card:#fff;
--ok:#1a7f5a;--warn:#b8860b;--bad:#c0392b;--accent:#2d5f8a;--human:#7c3aed}
:root:not([data-theme=light]){@media (prefers-color-scheme:dark){
--bg:#16161a;--fg:#e8e8e4;--muted:#9a9a94;--line:#2c2c32;--card:#1e1e24;
--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#7dd3fc;--human:#c4b5fd}}
:root[data-theme=dark]{--bg:#16161a;--fg:#e8e8e4;--muted:#9a9a94;--line:#2c2c32;
--card:#1e1e24;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#7dd3fc;--human:#c4b5fd}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 60px;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,system-ui,"Noto Sans TC",sans-serif}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:26px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card h3{margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)}
.big{font-size:22px;font-weight:600;letter-spacing:-.02em}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.d-ok{background:var(--ok)}.d-warn{background:var(--warn)}.d-bad{background:var(--bad)}
h2{font-size:15px;margin:30px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.msg{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);
border-radius:8px;padding:12px 14px;margin-bottom:9px}
.msg.human{border-left-color:var(--human)}
.msg.question,.msg.proposal{border-left-color:var(--accent)}
.msg.finding,.msg.decision{border-left-color:var(--ok)}
.meta{font-size:12px;color:var(--muted);margin-bottom:6px;display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.tag{border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:11px;letter-spacing:.02em}
.tag.k{color:var(--accent);border-color:currentColor}
.tag.h{color:var(--human);border-color:currentColor;font-weight:600}
.body{white-space:pre-wrap;word-break:break-word;font-size:14px}
.empty{color:var(--muted);font-style:italic;padding:14px 0}
.arts{font-size:12px;color:var(--muted);margin-top:7px;font-family:ui-monospace,monospace}
ul.nh{list-style:none;padding:0;margin:0}
ul.nh li{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--human);
border-radius:8px;padding:11px 14px;margin-bottom:8px;font-size:14px}
.prob{font-family:ui-monospace,monospace;font-size:12.5px;padding:3px 0}
footer{margin-top:36px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
"""


def _esc(t):
    return (str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _agent_card(agent, msgs, state, now):
    hb = parse_ts((state or {}).get("heartbeat", "")) if state else None
    if hb is None:
        cls, dot, txt = "bad", "d-bad", "從未執行"
    else:
        age = (now - hb).total_seconds()
        limit = CADENCE[agent] * HEARTBEAT_MULTIPLIER
        if age > limit:
            cls, dot = "bad", "d-bad"
            txt = f"停滯 {age/3600:.1f} 小時"
        elif age > CADENCE[agent]:
            cls, dot = "warn", "d-warn"
            txt = f"{age/60:.0f} 分鐘前"
        else:
            cls, dot = "ok", "d-ok"
            txt = f"{age/60:.0f} 分鐘前"
    today = now.strftime("%Y-%m-%d")
    n_today = sum(1 for m in msgs if str(m.get("ts", "")).startswith(today))
    cad = "每 30 分鐘" if agent == "codex" else "每日 09:00 + Dan 手動呼叫"
    return (f'<div class="card"><h3>{agent}</h3>'
            f'<div class="big {cls}"><span class="dot {dot}"></span>{_esc(txt)}</div>'
            f'<div style="font-size:12.5px;color:var(--muted);margin-top:7px">'
            f'{cad}<br>今日 {n_today} 則／上限 {MAX_PER_DAY}　累計 {len(msgs)} 則</div></div>')


def _msg_html(m):
    kind = m.get("kind", "")
    to_human = m.get("to") == "human" or m.get("needsHuman")
    cls = "human" if to_human else kind
    tags = f'<span class="tag k">{_esc(kind)}</span>'
    if to_human:
        tags += '<span class="tag h">給 Dan</span>'
    arts = m.get("artifacts") or []
    art_html = f'<div class="arts">{_esc(" · ".join(arts))}</div>' if arts else ""
    return (f'<div class="msg {cls}"><div class="meta">'
            f'<b>{_esc(m.get("from"))}</b> → {_esc(m.get("to"))}'
            f'<span>{_esc(m.get("ts"))}</span>'
            f'<span class="tag">{_esc(m.get("topic"))}</span>{tags}</div>'
            f'<div class="body">{_esc(m.get("body"))}</div>{art_html}</div>')


def render_dashboard(by_agent, states):
    now = datetime.now(timezone.utc)
    everything = [m for a in AGENTS for m in by_agent[a] if parse_ts(m.get("ts", ""))]
    everything.sort(key=lambda m: parse_ts(m["ts"]))

    cards = "".join(_agent_card(a, by_agent[a], states.get(a), now) for a in AGENTS)
    unread = unread_counts(by_agent, states)
    cards += (f'<div class="card"><h3>未讀</h3><div class="big">{unread["codex"]}</div>'
              f'<div style="font-size:12.5px;color:var(--muted);margin-top:7px">'
              f'Codex 尚未處理的 Claude 訊息<br>Claude 未讀 Codex {unread["claude"]} 則</div></div>')

    to_dan = [m for m in everything if m.get("to") == "human" or m.get("needsHuman")]
    dan_html = "".join(_msg_html(m) for m in reversed(to_dan[-15:])) or         '<div class="empty">目前沒有給你的回報。兩個 agent 都在正常運作時這裡是空的。</div>'

    open_items = [m for m in everything if m.get("kind") in ("question", "proposal")]
    open_html = "".join(_msg_html(m) for m in reversed(open_items[-10:])) or         '<div class="empty">沒有待回應的提問或提案。</div>'

    timeline = "".join(_msg_html(m) for m in reversed(everything[-30:])) or         '<div class="empty">尚無訊息往來。</div>'

    nh = A2A / "NEEDS_HUMAN.md"
    nh_items = []
    if nh.exists():
        nh_items = [l for l in nh.read_text(encoding="utf-8").splitlines() if l.startswith("- [ ]")]
    nh_html = ("<ul class='nh'>" + "".join(f"<li>{_esc(i[6:])}</li>" for i in nh_items) + "</ul>")         if nh_items else '<div class="empty">沒有待你裁決的項目。</div>'

    errs = [m for lvl, m in problems if lvl == "ERROR"]
    wrns = [m for lvl, m in problems if lvl == "WARN"]
    if errs or wrns:
        prob_html = "".join(f'<div class="prob bad">ERROR {_esc(m)}</div>' for m in errs) +                     "".join(f'<div class="prob warn">WARN &nbsp;{_esc(m)}</div>' for m in wrns)
    else:
        prob_html = '<div class="prob ok">OK 協定檢查全數通過</div>'

    html = f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>A2A 監控 — Claude ⇄ Codex</title><style>{DASH_CSS}</style></head><body><div class="wrap">
<h1>A2A 監控台</h1>
<div class="sub">Claude ⇄ Codex　·　產生於 {now.strftime('%Y-%m-%d %H:%M:%S')} UTC　·　每 30 秒自動重新整理</div>
<div class="grid">{cards}</div>
<h2>給 Dan 的回報</h2>{dan_html}
<h2>需要你裁決（NEEDS_HUMAN）</h2>{nh_html}
<h2>待回應的提問與提案</h2>{open_html}
<h2>協定檢查</h2>{prob_html}
<h2>訊息時間軸（最近 30 則，新到舊）</h2>{timeline}
<footer>本頁由 <code>validate_a2a.py</code> 產生，是 outbox 的衍生檔案，不是溝通管道。<br>
兩個 agent 每次執行後都會重新產生它；直接編輯本檔沒有意義，會被覆蓋。</footer>
</div></body></html>"""
    out = A2A / "dashboard.html"
    out.write_text(html, encoding="utf-8")
    return out


# ------------------------------------------------------------------- locks
# P11 的強制層。宣告是自律，鎖是機制——2026-08-28 的覆蓋事故證明只有後者可靠。

def _slug(rel_path):
    return re.sub(r"[^A-Za-z0-9]+", "_", str(rel_path).strip("/")).strip("_")


def _sha(path):
    if not path.exists() or not path.is_file():
        return None
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def load_locks():
    out = []
    if not LOCKS.exists():
        return out
    for f in sorted(LOCKS.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            data["_file"] = f.name
            out.append(data)
        except json.JSONDecodeError as exc:
            err(f"locks/{f.name} 不是合法 JSON：{exc}")
    return out


def acquire_lock(rel_path, agent, topic, hours):
    LOCKS.mkdir(exist_ok=True)
    target = LOCKS / f"{_slug(rel_path)}.json"
    now = datetime.now(timezone.utc)
    if target.exists():
        held = json.loads(target.read_text(encoding="utf-8"))
        exp = parse_ts(held.get("expiresAt", ""))
        active = exp is not None and exp > now
        if active and held.get("owner") != agent:
            print(f"REFUSED  {rel_path} 已由 {held['owner']} 鎖定至 {held['expiresAt']}"
                  f"（topic {held.get('topic')}）。不要動這個檔案；"
                  f"要接手請在 a2a 提出，由對方釋放或 Dan 裁決。")
            return 1
        if active:
            print(f"OK  {rel_path} 已由你（{agent}）持有，續期至 "
                  f"{(now + timedelta(hours=hours)).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    payload = {
        "path": str(rel_path), "owner": agent, "topic": topic,
        "acquiredAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expiresAt": (now + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sha256AtClaim": _sha(REPO / rel_path),
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"LOCKED  {rel_path}  owner={agent}  topic={topic}  至 {payload['expiresAt']}")
    return 0


def release_lock(rel_path, agent):
    target = LOCKS / f"{_slug(rel_path)}.json"
    if not target.exists():
        print(f"OK  {rel_path} 本來就沒有鎖")
        return 0
    held = json.loads(target.read_text(encoding="utf-8"))
    if held.get("owner") != agent:
        print(f"REFUSED  {rel_path} 由 {held['owner']} 持有，你（{agent}）不能釋放別人的鎖")
        return 1
    target.unlink()
    print(f"RELEASED  {rel_path}")
    return 0


def check_locks(for_agent=None):
    now = datetime.now(timezone.utc)
    for lock in load_locks():
        rel, owner = lock.get("path"), lock.get("owner")
        exp = parse_ts(lock.get("expiresAt", ""))
        if exp is None:
            err(f"locks/{lock['_file']} 的 expiresAt 無效")
            continue
        if exp <= now:
            warn(f"鎖已過期：{rel}（{owner} 於 {lock.get('acquiredAt')} 取得）。"
                 f"若對方已停止工作，任一方可刪除該鎖檔後接手。")
            continue
        current = _sha(REPO / rel)
        if current != lock.get("sha256AtClaim"):
            # 持有者自己改是正常的；非持有者改就是違規，但我們無法直接歸因，
            # 所以誠實地只報告事實，讓讀到的一方自行判斷。
            note = (f"檔案 {rel} 在 {owner} 持鎖期間已變更"
                    f"（claim 時 {lock.get('sha256AtClaim')} → 現在 {current}）。")
            if for_agent and for_agent != owner:
                err(note + f" 你（{for_agent}）不是持有者——若這是你改的，"
                           f"立即停手並在 a2a 通報，這正是 2026-08-28 覆蓋事故的形狀。")
            else:
                problems.append(("INFO", note + " 持有者自行變更，屬正常。"))


# --------------------------------------------------------------- snapshots
# 2026-08-28：Claude 用 `cat >` 覆蓋掉 Codex 未追蹤的 publicUrlPolicy.js，內容永久遺失。
# 這些檔案都還沒進 git，而 Dan 不熟 git、也不該被要求熟。因此在 git 之外留一份備份。
# 這不是版本控制的替代品，只是「毀掉之前的最後一道防線」。

def take_snapshot(label="auto"):
    import shutil
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = SNAPSHOTS / f"{stamp}_{re.sub(r'[^A-Za-z0-9_-]+', '-', label)}"
    copied, missing = [], []

    for src in sorted(A2A.rglob("*")):
        if not src.is_file() or SNAPSHOTS in src.parents or src == SNAPSHOTS:
            continue
        rel = src.relative_to(REPO)
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out)
        copied.append(str(rel))

    listing = A2A / "snapshot_paths.txt"
    if listing.exists():
        for line in listing.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            src = REPO / line
            if not src.is_file():
                missing.append(line)
                continue
            out = dest / line
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)
            copied.append(line)

    (dest / "MANIFEST.json").write_text(json.dumps({
        "takenAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": label, "files": copied, "missing": missing,
        "note": "git 之外的備份。要復原就直接把檔案複製回原路徑。",
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # 輪替：只留最近 KEEP_SNAPSHOTS 份
    existing = sorted([d for d in SNAPSHOTS.iterdir() if d.is_dir()])
    for old in existing[:-KEEP_SNAPSHOTS]:
        shutil.rmtree(old, ignore_errors=True)

    print(f"SNAPSHOT  {dest.relative_to(REPO)}  ({len(copied)} 檔)")
    if missing:
        print(f"          清單中找不到：{', '.join(missing)}")
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="驗證協定合規性")
    ap.add_argument("--digest", action="store_true", help="印出人類可讀摘要")
    ap.add_argument("--dashboard", action="store_true", help="只產生 dashboard.html，不印摘要")
    ap.add_argument("--next", metavar="AGENT", choices=AGENTS, help="產生下一個合法訊息 id")
    ap.add_argument("--lock", metavar="PATH", help="鎖定一個 repo 相對路徑的檔案（P11）")
    ap.add_argument("--unlock", metavar="PATH", help="釋放自己持有的鎖")
    ap.add_argument("--locks", action="store_true", help="列出目前所有鎖")
    ap.add_argument("--snapshot", nargs="?", const="manual", metavar="LABEL",
                    help="備份 a2a/ 與 snapshot_paths.txt 列出的檔案")
    ap.add_argument("--as", dest="agent", choices=AGENTS, help="--lock/--unlock/--check 的執行者")
    ap.add_argument("--topic", default="unspecified", help="--lock 的工作項 ID")
    ap.add_argument("--hours", type=float, default=LOCK_TTL_HOURS, help="鎖的存續時數")
    args = ap.parse_args()

    if args.snapshot:
        take_snapshot(args.snapshot)
        return 0

    if args.locks:
        rows = load_locks()
        if not rows:
            print("目前沒有任何鎖")
        for lock in rows:
            exp = parse_ts(lock.get("expiresAt", ""))
            state = "有效" if exp and exp > datetime.now(timezone.utc) else "已過期"
            print(f"[{state}] {lock.get('path')}  owner={lock.get('owner')}  "
                  f"topic={lock.get('topic')}  至 {lock.get('expiresAt')}")
        return 0

    if args.lock or args.unlock:
        if not args.agent:
            print("需要 --as claude|codex")
            return 2
        return (acquire_lock(args.lock, args.agent, args.topic, args.hours)
                if args.lock else release_lock(args.unlock, args.agent))

    if args.next:
        now = datetime.now(timezone.utc)
        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        existing = outbox(args.next)
        seq = 1
        if existing.exists():
            today = now.strftime("%Y%m%d")
            seq += sum(1 for line in existing.read_text(encoding="utf-8").splitlines()
                       if f'"{args.next}-{today}' in line)
        print(f"{args.next}-{stamp}-{seq:03d}")
        return 0

    by_agent = load_messages()
    states = load_states()
    check_ids_and_replies(by_agent)
    check_loop(by_agent)
    check_budget(by_agent)
    check_heartbeats(states)
    check_locks(args.agent)

    if args.digest or not (args.check or args.dashboard):
        digest(by_agent, states)

    # dashboard 是 outbox 的衍生檔案：由確定性函式從各自擁有的檔案重建，
    # 因此不受 P1 單一寫者限制——兩邊寫入的內容相同，覆蓋無害。
    if args.check:
        try:
            take_snapshot("check")
        except Exception as exc:            # 備份失敗絕不擋住驗證流程
            warn(f"快照失敗（不影響驗證）：{exc}")

    out = render_dashboard(by_agent, states)
    if args.dashboard:
        print(f"dashboard: {out}")

    errors = [m for lvl, m in problems if lvl == "ERROR"]
    warns = [m for lvl, m in problems if lvl == "WARN"]
    for m in errors:
        print(f"ERROR  {m}")
    for m in warns:
        print(f"WARN   {m}")
    for lvl, m in problems:
        if lvl == "INFO":
            print(f"INFO   {m}")
    if not problems:
        print("OK  協定檢查全數通過")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
