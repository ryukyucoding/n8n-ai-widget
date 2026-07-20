#!/usr/bin/env python3
"""
Node Accuracy Evaluator

Evaluate node type accuracy and connection accuracy.
"""

from typing import Dict, Set, Tuple


class NodeAccuracyEvaluator:
    """
    Evaluate node type and connection accuracy
    """

    def evaluate_node_types(self, matching_result: Dict) -> Dict:
        """
        Calculate node type precision, recall, F1

        Args:
            matching_result: Result from NodeMatcher

        Returns:
            Dictionary with node type metrics
        """
        # TP: Matched nodes with same type
        tp = len([m for m in matching_result['matches'] if m['type_match']])

        # FP: LLM generated nodes with no GT match
        fp = len(matching_result['unmatched_llm'])

        # FN: GT nodes with no LLM match
        fn = len(matching_result['unmatched_gt'])

        # Calculate metrics
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        return {
            "node_type_precision": precision,
            "node_type_recall": recall,
            "node_type_f1": f1,
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "gt_node_count": tp + fn,
            "llm_node_count": tp + fp
        }

    def evaluate_connections(self, gt_workflow: Dict, llm_workflow: Dict) -> Dict:
        """
        Calculate connection accuracy based on node types

        Method:
        1. Create name-to-type mappings for both workflows
        2. Convert connections to (from_type, to_type) tuples
        3. Count intersection (correct connections)
        4. Calculate precision, recall, F1

        Args:
            gt_workflow: Normalized ground truth workflow
            llm_workflow: Normalized LLM workflow

        Returns:
            Dictionary with connection metrics
        """
        # Create name to type mappings
        gt_name_to_type = {node['name']: node['type'] for node in gt_workflow['nodes']}
        llm_name_to_type = {node['name']: node['type'] for node in llm_workflow['nodes']}

        # Convert to sets of (from_type, to_type) tuples
        gt_conn_set = self._connections_to_type_set(gt_workflow['connections'], gt_name_to_type)
        llm_conn_set = self._connections_to_type_set(llm_workflow['connections'], llm_name_to_type)

        # Calculate metrics
        correct = len(gt_conn_set & llm_conn_set)  # Intersection
        total_gt = len(gt_conn_set)
        total_llm = len(llm_conn_set)

        precision = correct / total_llm if total_llm > 0 else 0.0
        recall = correct / total_gt if total_gt > 0 else 0.0
        f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

        return {
            "connection_precision": precision,
            "connection_recall": recall,
            "connection_f1": f1,
            "correct_connections": correct,
            "gt_connection_count": total_gt,
            "llm_connection_count": total_llm
        }

    def _connections_to_type_set(self, connections: list, name_to_type: Dict[str, str]) -> Set[Tuple[str, str]]:
        """
        Convert connection list to set of (from_type, to_type) tuples

        Args:
            connections: List of connection dictionaries
            name_to_type: Mapping from node name to node type

        Returns:
            Set of (from_type, to_type) tuples
        """
        conn_set = set()

        for conn in connections:
            from_name = conn.get('from', '')
            to_name = conn.get('to', '')

            # Resolve names to types
            from_type = name_to_type.get(from_name, '')
            to_type = name_to_type.get(to_name, '')

            if from_type and to_type:
                conn_set.add((from_type, to_type))

        return conn_set
