#!/usr/bin/env node
'use strict';

// Run this inside the n8n container. It serializes node descriptions already
// loaded from the installed packages, so the chatbot validates against that
// exact n8n version instead of a hand-maintained node list.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const root = process.argv[2] || '/usr/local/lib/node_modules/n8n/node_modules';
const output = process.argv[3] || '/tmp/runtime_node_schemas.json';
const agentSchemaDirectory = process.argv[4] || '/tmp/runtime_node_schemas';
const packages = [
  ['n8n-nodes-base', 'n8n-nodes-base'],
  ['@n8n/n8n-nodes-langchain', '@n8n/n8n-nodes-langchain'],
];
const nodeTypes = {};
const skipped = [];

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const [packagePath, namespace] of packages) {
  const directories = execFileSync('find', [root, '-path', `*/node_modules/${packagePath}/dist/nodes`, '-type', 'd'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  for (const directory of directories) {
    const files = execFileSync('find', [directory, '-type', 'f', '-name', '*.node.js'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    for (const file of files) {
      try {
        const moduleExports = require(file);
        for (const exported of Object.values(moduleExports)) {
          if (typeof exported !== 'function') continue;
          let instance;
          try { instance = new exported(); } catch { continue; }
          const descriptions = instance.nodeVersions
            ? Object.fromEntries(Object.entries(instance.nodeVersions).map(([version, node]) => [version, jsonClone(node.description)]))
            : Object.fromEntries((Array.isArray(instance.description?.version) ? instance.description.version : [instance.description?.version])
              .filter((version) => version !== undefined)
              .map((version) => [String(version), jsonClone(instance.description)]));
          for (const description of Object.values(descriptions)) {
            if (!description?.name || !Array.isArray(description.properties)) continue;
            const type = `${namespace}.${description.name}`;
            nodeTypes[type] ??= { versions: {} };
            Object.assign(nodeTypes[type].versions, descriptions);
          }
        }
      } catch (error) {
        skipped.push({ file, error: error.message });
      }
    }
  }
}

// R17：快照原本只有 generatedAt，沒有任何版本錨點。時間戳只能說明「多久沒抓」，
// 不能說明「runtime 是否真的變了」——一次無實質變更的重抓也會產生新時間戳。
// 因此加入三個欄位，讓 approval fingerprint 有東西可綁（見 a2a topic R1）：
//   n8nVersion       實際安裝的 n8n 版本
//   nodeTypesDigest  對正規化後的 nodeTypes 取 SHA-256；內容沒變時 digest 不變
//   exportToolFormat 本工具的輸出格式版本
function detectN8nVersion() {
  for (const candidate of [
    `${root}/n8n/package.json`,
    '/usr/local/lib/node_modules/n8n/package.json',
  ]) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')).version; } catch { /* next */ }
  }
  try { return execFileSync('n8n', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

// 穩定序列化：key 排序後再 hash，讓 digest 只反映內容、不反映鍵的插入順序。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const nodeTypesDigest = crypto.createHash('sha256').update(stableStringify(nodeTypes)).digest('hex');
const n8nVersion = detectN8nVersion();
if (!n8nVersion) {
  console.warn('[warn] 無法偵測 n8n 版本；快照的 n8nVersion 會是 null，freshness 檢查會降級為僅比對 digest。');
}

fs.writeFileSync(output, JSON.stringify({
  format: 1,
  exportToolFormat: 2,
  generatedAt: new Date().toISOString(),
  n8nVersion,
  nodeTypesDigest,
  nodeTypeCount: Object.keys(nodeTypes).length,
  nodeTypes,
  skipped,
}, null, 2));
fs.rmSync(agentSchemaDirectory, { recursive: true, force: true });
fs.mkdirSync(agentSchemaDirectory, { recursive: true });
for (const [type, node] of Object.entries(nodeTypes)) {
  const versions = Object.keys(node.versions).sort((left, right) => Number(right) - Number(left));
  const latestVersion = versions[0];
  if (!latestVersion) continue;
  const description = { ...node.versions[latestVersion], name: type, typeVersion: Number(latestVersion) };
  const filename = `${type.replace(/[^a-zA-Z0-9]+/g, '_')}.json`;
  fs.writeFileSync(`${agentSchemaDirectory}/${filename}`, JSON.stringify(description, null, 2));
}
console.log(`n8n ${n8nVersion || 'unknown'} · digest ${nodeTypesDigest.slice(0, 16)}`);
console.log(`Exported ${Object.keys(nodeTypes).length} validated node types to ${output} and ${agentSchemaDirectory}; skipped ${skipped.length} modules.`);
