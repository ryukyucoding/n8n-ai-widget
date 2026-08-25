import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

json_repair_stub = types.ModuleType("json_repair")
json_repair_stub.repair_json = lambda raw: raw
sys.modules.setdefault("json_repair", json_repair_stub)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workflow_repair import (  # noqa: E402
    RuntimeSchemaStore,
    StructuredValidationError,
    main,
    safe_benchmark_finding,
    validate_connection_ports,
    validate_node_parameters,
)


def schema_store() -> RuntimeSchemaStore:
    store = RuntimeSchemaStore.__new__(RuntimeSchemaStore)
    store.schemas = {
        "test.node": {"versions": {"1": {"properties": []}}},
        "test.source": {"versions": {"1": {"outputs": ["main"]}}},
        "test.target": {"versions": {"1": {"inputs": ["main", "main"]}}},
    }
    return store


class BenchmarkStaticProtocolTests(unittest.TestCase):
    def protocol_output(self, side_effect):
        stdin = io.StringIO(json.dumps({"raw_output": "{}", "benchmarkStaticProtocol": True}))
        stdout = io.StringIO()
        with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch(
            "workflow_repair.process_and_verify_workflow", side_effect=side_effect
        ):
            with self.assertRaises(SystemExit):
                main()
        return json.loads(stdout.getvalue())

    def test_safe_envelope_has_fixed_keys_without_sensitive_detail(self):
        finding = safe_benchmark_finding("parameter_schema", "repair", True, False, True)
        error = StructuredValidationError("private node and parameter details", [finding])
        envelope = self.protocol_output(error)
        self.assertEqual(envelope, {"ok": False, "findings": [finding], "unstructuredFailure": False})
        text = json.dumps(envelope)
        for forbidden in ("node", "id", "position", "workflow", "prompt", "url", "secret", "error", "rule"):
            self.assertNotIn(forbidden, text.lower())

    def test_successful_normalization_is_nonblocking_and_contains_no_workflow(self):
        stdin = io.StringIO(json.dumps({"raw_output": "{}", "benchmarkStaticProtocol": True}))
        stdout = io.StringIO()
        with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch(
            "workflow_repair.process_and_verify_workflow", return_value=({"private": "workflow"}, [{"private": "repair"}])
        ):
            main()
        envelope = json.loads(stdout.getvalue())
        self.assertEqual(envelope, {"ok": True, "findings": [safe_benchmark_finding("connection_port", "warning", False, True, False)], "unstructuredFailure": False})
        self.assertNotIn("workflow", json.dumps(envelope).lower())

    def test_unstructured_failure_has_no_inferred_finding(self):
        envelope = self.protocol_output(ValueError("private node name and URL"))
        self.assertEqual(envelope, {"ok": False, "findings": [], "unstructuredFailure": True})

    def test_parameter_schema_and_type_version_are_deterministic(self):
        parameter_candidate = {"nodes": [{"name": "Private", "type": "test.node", "typeVersion": 1, "parameters": {"private": "value"}}]}
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store()):
            with self.assertRaises(StructuredValidationError) as parameter_error:
                validate_node_parameters(parameter_candidate)
        self.assertEqual(parameter_error.exception.safe_findings[0]["category"], "parameter_schema")

        version_candidate = {"nodes": [{"name": "Private", "type": "test.node", "typeVersion": 9, "parameters": {}}]}
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store()):
            with self.assertRaises(StructuredValidationError) as version_error:
                validate_node_parameters(version_candidate)
        self.assertEqual(version_error.exception.safe_findings[0]["category"], "type_version")

    def test_connection_port_error_is_structured_and_blocking(self):
        candidate = {
            "nodes": [
                {"name": "Source", "type": "test.source", "typeVersion": 1, "parameters": {}},
                {"name": "Target", "type": "test.target", "typeVersion": 1, "parameters": {}},
            ],
            "connections": {"Source": {"main": [[{"node": "Target", "type": "main", "index": 3}]]}},
        }
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store()):
            with self.assertRaises(StructuredValidationError) as error:
                validate_connection_ports(candidate)
        self.assertEqual(error.exception.safe_findings, [safe_benchmark_finding("connection_port", "repair", True, False, True)])


if __name__ == "__main__":
    unittest.main()
