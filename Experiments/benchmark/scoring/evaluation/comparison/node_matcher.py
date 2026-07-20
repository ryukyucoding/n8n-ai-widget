#!/usr/bin/env python3
"""
Node Matcher

Match LLM-generated nodes to ground truth nodes for evaluation.
"""

from typing import Dict, List


class NodeMatcher:
    """
    Match LLM nodes to ground truth nodes using greedy type-based matching
    """

    def match_nodes(self, gt_nodes: List[Dict], llm_nodes: List[Dict]) -> Dict:
        """
        Match LLM nodes to ground truth nodes

        Strategy:
        1. Group nodes by type
        2. Match sequentially within same type
        3. Unmatched nodes are FP (LLM) or FN (GT)

        Args:
            gt_nodes: Ground truth nodes
            llm_nodes: LLM-generated nodes

        Returns:
            Dictionary with:
            - matches: List of matched node pairs
            - unmatched_gt: GT nodes with no match (false negatives)
            - unmatched_llm: LLM nodes with no match (false positives)
        """
        matches = []
        matched_gt_ids = set()
        matched_llm_ids = set()

        # Group by type
        gt_by_type = self._group_by_type(gt_nodes)
        llm_by_type = self._group_by_type(llm_nodes)

        # Get all types
        all_types = set(gt_by_type.keys()) | set(llm_by_type.keys())

        # Match nodes of same type
        for node_type in all_types:
            gt_type_nodes = gt_by_type.get(node_type, [])
            llm_type_nodes = llm_by_type.get(node_type, [])

            # Match sequentially (greedy)
            num_matches = min(len(gt_type_nodes), len(llm_type_nodes))

            for i in range(num_matches):
                gt_node = gt_type_nodes[i]
                llm_node = llm_type_nodes[i]

                matches.append({
                    "gt_node": gt_node,
                    "llm_node": llm_node,
                    "type_match": True  # Always true since we match by type
                })

                matched_gt_ids.add(gt_node['id'])
                matched_llm_ids.add(llm_node['id'])

        # Collect unmatched nodes
        unmatched_gt = [n for n in gt_nodes if n['id'] not in matched_gt_ids]
        unmatched_llm = [n for n in llm_nodes if n['id'] not in matched_llm_ids]

        return {
            "matches": matches,
            "unmatched_gt": unmatched_gt,
            "unmatched_llm": unmatched_llm
        }

    def _group_by_type(self, nodes: List[Dict]) -> Dict[str, List[Dict]]:
        """
        Group nodes by their type

        Args:
            nodes: List of node dictionaries

        Returns:
            Dictionary mapping type to list of nodes
        """
        groups = {}

        for node in nodes:
            node_type = node.get('type', 'unknown')

            if node_type not in groups:
                groups[node_type] = []

            groups[node_type].append(node)

        return groups
