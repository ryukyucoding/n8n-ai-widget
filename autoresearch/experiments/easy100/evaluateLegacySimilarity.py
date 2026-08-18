#!/usr/bin/env python3
"""Compare a private Easy-100 prediction file using the existing legacy metrics.

The output is an aggregate-only JSON report. It never prints workflows, prompts,
or credential-like values. This metric remains a historical topology comparison,
not evidence that a workflow executed correctly.
"""

import argparse
import json
import sys
from pathlib import Path


def mean(values):
    return sum(values) / len(values) if values else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--generator-root', required=True)
    parser.add_argument('--source-jsonl', required=True)
    parser.add_argument('--input-jsonl', required=True)
    parser.add_argument('--output-json', required=True)
    args = parser.parse_args()

    generator_root = Path(args.generator_root).resolve()
    sys.path.insert(0, str(generator_root))
    from evaluation.comparison.workflow_normalizer import WorkflowNormalizer
    from evaluation.comparison.node_matcher import NodeMatcher
    from evaluation.evaluators.node_accuracy_evaluator import NodeAccuracyEvaluator

    normalizer = WorkflowNormalizer()
    matcher = NodeMatcher()
    evaluator = NodeAccuracyEvaluator()
    ground_truth_by_id = {}
    for line in Path(args.source_jsonl).read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        source = json.loads(line)
        assistant = next((entry.get('content') for entry in source.get('messages', []) if entry.get('role') == 'assistant'), None)
        try:
            ground_truth_by_id[str(source.get('id'))] = json.loads(assistant) if isinstance(assistant, str) else None
        except json.JSONDecodeError:
            ground_truth_by_id[str(source.get('id'))] = None
    rows = []
    for line in Path(args.input_jsonl).read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        prediction = record.get('predicted')
        ground_truth = ground_truth_by_id.get(str(record.get('id')))
        if not isinstance(prediction, dict) or not isinstance(ground_truth, dict):
            rows.append({'caseId': str(record.get('id')), 'status': 'not_scoreable'})
            continue
        gt = normalizer.normalize_llm_output(ground_truth)
        predicted = normalizer.normalize_llm_output(prediction)
        matches = matcher.match_nodes(gt['nodes'], predicted['nodes'])
        metrics = {}
        metrics.update(evaluator.evaluate_node_types(matches))
        metrics.update(evaluator.evaluate_connections(gt, predicted))
        metrics.update(evaluator.evaluate_matched_connections(gt, predicted, matches))
        rows.append({'caseId': str(record.get('id')), 'status': 'scored', 'metrics': {
            'node_type_f1': metrics['node_type_f1'],
            'connection_f1': metrics['connection_f1'],
            'matched_connection_f1': metrics['matched_connection_f1'],
        }})

    scored = [row['metrics'] for row in rows if row['status'] == 'scored']
    report = {
        'schemaVersion': '1.0',
        'kind': 'easy100_legacy_similarity_report',
        'metricScope': 'historical_topology_similarity_not_execution_evidence',
        'attempted': len(rows), 'scored': len(scored),
        'mean': {key: mean([row[key] for row in scored]) for key in ('node_type_f1', 'connection_f1', 'matched_connection_f1')},
        'rows': rows,
    }
    output = Path(args.output_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
