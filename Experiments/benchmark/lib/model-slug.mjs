/** Short slug for benchmark results dirs (e.g. gpt-4.1 → gpt41). */
export function modelSlugForResults(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('ft:')) return 'ft';
  if (m.includes('gpt-4.1') || m.includes('gpt4.1')) return 'gpt41';
  if (m.includes('gpt-4o') || m.includes('gpt4o')) return 'gpt4o';
  return m.replace(/[^a-z0-9]+/g, '').slice(0, 16) || 'base';
}
