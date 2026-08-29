# C7 — 驗證一個 Claude 的可證偽預測

**唯讀任務。不修改任何檔案、不安裝套件、不碰容器、不做 git 寫入。**

## 背景

`chatProgress.test.js` 第 68 行在 Dan 的 Windows checkout 上失敗。Claude 的診斷是：
那是 CRLF 假象，不是 bug —— 測試用 **LF 換行的字串字面值**去比對 `chat.html`，
而 Windows checkout 的該檔是 CRLF。

Claude 在 Windows 上實測過：
```
s.includes('} else {\n          res = await fetch(AGENT_URL, {')    → false
s.includes('} else {\r\n          res = await fetch(AGENT_URL, {')  → true
```

**Claude 的預測：在 .44 的 Linux checkout（git 以 LF 取出）該測試會通過。**

## 要做的事

```sh
cd /data/daniel/n8n-worktrees/runtime-compiler-integration/chatbot
node --test src/chatProgress.test.js 2>&1 | tail -25
```

再確認換行符本身，避免只看測試結果而不知道原因：

```sh
file src/chat.html
node -e 'const s=require("fs").readFileSync("src/chat.html","utf8");
console.log("CRLF 出現次數:", (s.match(/\r\n/g)||[]).length);
console.log("LF 版比對:", s.includes("} else {\n          res = await fetch(AGENT_URL, {"));
console.log("CRLF版比對:", s.includes("} else {\r\n          res = await fetch(AGENT_URL, {"));'
```

## 要回報的

1. 測試的 pass/fail 統計原文。
2. 上面換行符檢查的完整輸出。
3. **明確結論：Claude 的預測正確還是錯誤。**

**若該測試在 .44 仍然失敗，代表 Claude 的診斷是錯的——請直接說「預測錯誤」並附上實際的斷言訊息。**
不要為了配合預測而修飾結果。這一題的價值就在於它可以證偽。

## 順帶回報（各一行，不必深究）

```sh
cd /data/daniel/n8n-worktrees/runtime-compiler-integration/chatbot
node -e 'try{require("dotenv");console.log("dotenv: 有")}catch(e){console.log("dotenv: 缺")}'
git -C /data/daniel/n8n-worktrees/runtime-compiler-integration log --oneline -1
node --version
```

這是要確認：這個 worktree 是否也缺 `dotenv`（Dan 的 Windows 端缺，導致 full suite 跑不了），
以及它停在哪個 commit —— **它沒有 Claude 今天的 R1/R2/R3/R17 變更**，所以除了 C7 之外
不要在這個 worktree 上驗證今天的工作，那會得到誤導性的結果。

## 輸出

請寫入 `/data/daniel/c7_report.md`，Dan 會取回。
