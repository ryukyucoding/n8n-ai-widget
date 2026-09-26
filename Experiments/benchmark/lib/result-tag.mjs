/**
 * Console tags for benchmark results.
 * Insert uses four thesis tiers: Perfect | Splice Error | Insert Type Mismatch | Ambiguous
 */

export function promptInstruction(caseEntry) {
  return String(caseEntry?.instruction || caseEntry?.instruction_full || '').trim();
}

/** Add oracle ``between`` anchors to insert-full-style prompts (gold still workflow). */
export function instructionWithLocation(caseEntry) {
  const instr = promptInstruction(caseEntry);
  const between = caseEntry?.oracle_clue?.location?.between;
  if (!Array.isArray(between) || between.length !== 2) {
    return instr;
  }
  if (/\bbetween\s+"/i.test(instr)) {
    return instr;
  }
  const [left, right] = between.map(String);
  const typed = instr.match(/^Insert the node "([^"]+)" of type "([^"]+)"/);
  if (typed) {
    return instr.replace(
      `Insert the node "${typed[1]}" of type "${typed[2]}"`,
      `Insert the node "${typed[1]}" of type "${typed[2]}" between "${left}" and "${right}"`
    );
  }
  const plain = instr.match(/^Insert the node "([^"]+)"/);
  if (plain) {
    return instr.replace(
      `Insert the node "${plain[1]}"`,
      `Insert the node "${plain[1]}" between "${left}" and "${right}"`
    );
  }
  return instr;
}

export function formatInsertDetailLines(score) {
  const d = score?.insert_detail;
  if (!d?.checks) return [];

  const lines = [];
  const c = d.checks;

  lines.push(`  節點: ${c.node_name_present?.ok ? '✓' : '✗'} ${c.node_name_present?.expected_name || '?'}`);

  const typeOk = c.node_type_match?.ok;
  lines.push(
    `  type: ${typeOk ? '✓' : '✗'} gold=${c.node_type_match?.gold_type || '?'} pred=${c.node_type_match?.pred_type || '?'}`
  );

  const sp = c.splice_position || {};
  lines.push(
    `  splice: ${sp.ok ? '✓' : '✗'} in=[${(sp.pred_incoming || []).join(', ')}] out=[${(sp.pred_outgoing || []).join(', ')}]` +
      (sp.ok ? '' : ` (gold in=[${(sp.gold_incoming || []).join(', ')}] out=[${(sp.gold_outgoing || []).join(', ')}])`)
  );

  const p = c.parameters || {};
  if (p.coverage_rate != null) {
    const pct = Math.round(Number(p.coverage_rate) * 100);
    lines.push(`  參數覆蓋: ${p.covered_paths}/${p.total_paths} (${pct}%)`);
    if (p.missing_paths?.length) {
      lines.push(`  缺少參數: ${p.missing_paths.slice(0, 8).join(', ')}${p.missing_paths.length > 8 ? '…' : ''}`);
    }
  }

  const col = c.collateral || {};
  if (col.other_nodes_semantically_changed?.length) {
    lines.push(`  其他節點被改動: ${col.other_nodes_semantically_changed.join(', ')}`);
  }
  if (col.extra_nodes_beyond_insert?.length) {
    lines.push(`  額外新增: ${col.extra_nodes_beyond_insert.join(', ')}`);
  }
  if (col.base_nodes_missing_from_pred?.length) {
    lines.push(`  原節點被刪: ${col.base_nodes_missing_from_pred.join(', ')}`);
  }

  if (score.insert_ambiguity_label) {
    lines.push(`  ambiguous 原因: ${score.insert_ambiguity_label}`);
  } else if (d.ambiguity_reasons?.length) {
    lines.push(`  ambiguous 原因: ${d.ambiguity_reasons.join(', ')}`);
  }

  return lines;
}

export function formatResultTag({ operation, score, meta }) {
  const scoringOp = operation?.startsWith('insert') ? 'insert' : operation;

  if (scoringOp === 'insert' && score?.insert_status_label) {
    const tier = score.insert_status_label;
    const ok = score.success ? 'OK' : 'FAIL';
    return `${ok}/${tier}`;
  }

  if (score?.success) return 'OK';

  if (meta?.aiOutcome?.looksLikeClarification) return 'FAIL/ASK';
  if (meta?.aiOutcome?.looksLikeWrongEdit) return 'FAIL/NO_SAVE';
  return 'FAIL';
}
