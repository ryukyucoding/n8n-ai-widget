'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  return 'Usage: node autoresearch/client/task-client.js --request <safe-request.json>';
}

function requestPathFromArgs(args) {
  if (args.length !== 2 || args[0] !== '--request') throw new Error(usage());
  return args[1];
}

function readRequest(requestPath) {
  const absolutePath = path.resolve(requestPath);
  let request;
  try {
    request = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    throw new Error('request file must contain valid JSON');
  }
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new Error('request file must contain a JSON-RPC 2.0 request');
  }
  return request;
}

async function sendRequest({ endpoint = process.env.A2A_BROKER_URL || 'http://127.0.0.1:8787', token = process.env.A2A_BROKER_TOKEN, request }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(new URL('/rpc', endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`broker returned HTTP ${response.status}`);
  return body;
}

async function main(args = process.argv.slice(2)) {
  const request = readRequest(requestPathFromArgs(args));
  const response = await sendRequest({ request });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { requestPathFromArgs, readRequest, sendRequest };
