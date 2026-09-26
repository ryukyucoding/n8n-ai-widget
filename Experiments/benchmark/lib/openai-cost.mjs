/**
 * Estimate OpenAI API cost from usage counters.
 * Rates are USD per 1M tokens; override via OPENAI_INPUT_USD_PER_1M / OPENAI_OUTPUT_USD_PER_1M.
 */

/** @type {Record<string, { input: number; output: number }>} */
const MODEL_RATES = {
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
};

function normalizeModelKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('ft:')) {
    if (m.includes('gpt-4.1') || m.includes('gpt4.1')) return 'gpt-4.1';
    if (m.includes('gpt-4o') || m.includes('gpt4o')) return 'gpt-4o';
  }
  for (const key of Object.keys(MODEL_RATES)) {
    if (m.includes(key.replace(/\./g, '')) || m.includes(key)) return key;
  }
  return 'gpt-4.1';
}

function ratesForModel(model) {
  const key = normalizeModelKey(model);
  const base = MODEL_RATES[key] || MODEL_RATES['gpt-4.1'];
  const input = Number(process.env.OPENAI_INPUT_USD_PER_1M || base.input);
  const output = Number(process.env.OPENAI_OUTPUT_USD_PER_1M || base.output);
  return { modelKey: key, inputUsdPer1M: input, outputUsdPer1M: output };
}

export function estimateOpenAiCost(usage = {}, model = 'gpt-4.1') {
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || prompt + completion);
  const { modelKey, inputUsdPer1M, outputUsdPer1M } = ratesForModel(model);
  const inputUsd = (prompt / 1_000_000) * inputUsdPer1M;
  const outputUsd = (completion / 1_000_000) * outputUsdPer1M;
  const totalUsd = inputUsd + outputUsd;
  return {
    model: modelKey,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    n_api_calls: Number(usage.n_api_calls || 0),
    input_usd: roundUsd(inputUsd),
    output_usd: roundUsd(outputUsd),
    total_usd: roundUsd(totalUsd),
    rates: { input_usd_per_1m: inputUsdPer1M, output_usd_per_1m: outputUsdPer1M },
  };
}

function roundUsd(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function mergeCostRows(rows) {
  const acc = {
    cases: rows.length,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    n_api_calls: 0,
    total_usd: 0,
  };
  for (const r of rows) {
    acc.prompt_tokens += r.prompt_tokens || 0;
    acc.completion_tokens += r.completion_tokens || 0;
    acc.total_tokens += r.total_tokens || 0;
    acc.n_api_calls += r.n_api_calls || 0;
    acc.total_usd += r.total_usd || 0;
  }
  acc.total_usd = roundUsd(acc.total_usd);
  return acc;
}
