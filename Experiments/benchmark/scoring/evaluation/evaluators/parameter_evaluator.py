#!/usr/bin/env python3
"""Parameter evaluator based on serialized parameter dictionaries."""

import json
import numpy as np
from typing import Any, Dict, List
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity


class ParameterEvaluator:
    """
    Evaluate parameter filling using semantic similarity
    """

    def __init__(
        self,
        model_name: str = "paraphrase-multilingual-mpnet-base-v2",
        threshold: float = 0.8
    ):
        """
        Initialize parameter evaluator

        Args:
            model_name: SentenceTransformer model name
            threshold: Similarity threshold for matching (default: 0.8)
        """
        self.model = SentenceTransformer(model_name)
        self.threshold = threshold

    def evaluate_parameters(self, matching_result: Dict) -> Dict:
        """
        Evaluate parameter filling accuracy

        For each matched node pair:
        1. Serialize the whole parameters dictionary.
        2. Compute cosine similarity on embeddings.
        3. Mark as correct if similarity >= threshold.

        Args:
            matching_result: Result from NodeMatcher

        Returns:
            Dictionary with parameter metrics
        """
        per_node_results = []
        node_scores = []

        for match in matching_result['matches']:
            gt_node = match['gt_node']
            llm_node = match['llm_node']

            gt_params = gt_node.get('parameters', {})
            llm_params = llm_node.get('parameters', {})

            param_result = self._compare_parameters(gt_params, llm_params)

            per_node_results.append({
                "gt_node_name": gt_node['name'],
                "llm_node_name": llm_node['name'],
                "cosine_similarity": param_result['cosine_similarity'],
                "is_correct": param_result['is_correct'],
                "match_ratio": param_result['match_ratio'],
            })

            node_scores.append(param_result['match_ratio'])

        # Calculate average
        avg_accuracy = np.mean(node_scores) if node_scores else 0.0

        return {
            "avg_parameter_accuracy": float(avg_accuracy),
            "per_node_accuracy": per_node_results
        }

    def _compare_parameters(self, gt_params: Dict[str, Any], llm_params: Dict[str, Any]) -> Dict[str, float]:
        """Compare whole parameter dictionaries by embedding similarity."""
        gt_text = self._serialize_params(gt_params)
        llm_text = self._serialize_params(llm_params)
        sim = self._compute_similarity(gt_text, llm_text)
        is_correct = 1.0 if sim >= self.threshold else 0.0
        return {
            "cosine_similarity": float(sim),
            "is_correct": float(is_correct),
            "match_ratio": float(is_correct),
        }

    def _serialize_params(self, params: Any) -> str:
        """Stable JSON string for whole-dict semantic comparison."""
        if params is None:
            return "null"
        if not isinstance(params, dict):
            return str(params)
        return json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _compute_similarity(self, text1: str, text2: str) -> float:
        """
        Compute cosine similarity between two texts

        Args:
            text1: First text
            text2: Second text

        Returns:
            Cosine similarity (0-1)
        """
        # Exact match shortcut
        if text1 == text2:
            return 1.0

        # Compute embeddings
        embeddings = self.model.encode([text1, text2])

        # Compute cosine similarity
        similarity = cosine_similarity([embeddings[0]], [embeddings[1]])[0][0]

        return float(similarity)
