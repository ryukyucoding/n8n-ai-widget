import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

json_repair_stub = types.ModuleType("json_repair")
json_repair_stub.repair_json = lambda raw: raw
sys.modules.setdefault("json_repair", json_repair_stub)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workflow_repair import RuntimeSchemaStore, StructuredValidationError, validate_connection_ports  # noqa: E402


def schema_store(single_inputs):
    store = RuntimeSchemaStore.__new__(RuntimeSchemaStore)
    store.schemas = {
        "test.source": {"versions": {"1": {"outputs": ["main"]}}},
        "test.source_multi": {"versions": {"1": {"outputs": ["main", "main"]}}},
        "test.source_unknown": {"versions": {"1": {}}},
        "test.single": {"versions": {"1": {"inputs": single_inputs}}},
        "test.multi": {"versions": {"1": {"inputs": ["main", "main"]}}},
        "test.unknown": {"versions": {"1": {}}},
    }
    return store


WEBHOOK_OUTPUTS = """
const httpMethod = $parameter.httpMethod;
if (!Array.isArray(httpMethod)) return [{ type: 'main' }];
return httpMethod.map((method) => ({ type: 'main' }));
"""

GEMINI_INPUTS = """
const resource = $parameter.resource;
const operation = $parameter.operation;
if (resource === 'text' && operation === 'message') {
  return [{ type: 'main' }, { type: 'ai_tool' }];
}
return ['main'];
"""


def workflow(target_type, index, source_type="test.source"):
    return {
        "nodes": [
            {"name": "Source", "type": source_type, "typeVersion": 1, "parameters": {}},
            {"name": "Target", "type": target_type, "typeVersion": 1, "parameters": {}},
        ],
        "connections": {
            "Source": {"main": [[{"node": "Target", "type": "main", "index": index}]]},
        },
    }


class ConnectionPortNormalizationTests(unittest.TestCase):
    def test_reads_explicit_single_or_array_output_port_pattern(self):
        store = schema_store(["main"])
        store.schemas["test.webhook"] = {"versions": {"1": {"outputs": WEBHOOK_OUTPUTS}}}
        self.assertEqual(store.output_ports_for({"type": "test.webhook", "typeVersion": 1, "parameters": {"httpMethod": "GET"}}), ["main"])
        self.assertEqual(store.output_ports_for({"type": "test.webhook", "typeVersion": 1, "parameters": {"httpMethod": ["GET", "POST"]}}), ["main", "main"])

    def test_reads_explicit_conditional_input_port_pattern(self):
        store = schema_store(["main"])
        store.schemas["test.gemini"] = {"versions": {"1": {"inputs": GEMINI_INPUTS}}}
        self.assertEqual(store.input_ports_for({"type": "test.gemini", "typeVersion": 1, "parameters": {"resource": "text", "operation": "message"}}), ["main", "ai_tool"])
        self.assertEqual(store.input_ports_for({"type": "test.gemini", "typeVersion": 1, "parameters": {"resource": "image", "operation": "generate"}}), ["main"])

    def test_normalizes_invalid_index_when_runtime_schema_has_one_compatible_input(self):
        candidate = workflow("test.single", 1)
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            repairs = validate_connection_ports(candidate)

        connection = candidate["connections"]["Source"]["main"][0][0]
        self.assertEqual(connection["index"], 0)
        self.assertEqual(repairs[0]["fromIndex"], 1)
        self.assertEqual(repairs[0]["toIndex"], 0)
        self.assertEqual(repairs[0]["connectionType"], "main")

    def test_normalizes_invalid_source_output_index_when_schema_has_one_compatible_output(self):
        candidate = workflow("test.single", 0)
        candidate["connections"]["Source"]["main"] = [[], [{"node": "Target", "type": "main", "index": 0}]]
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            repairs = validate_connection_ports(candidate)

        self.assertEqual(len(candidate["connections"]["Source"]["main"]), 1)
        self.assertEqual(candidate["connections"]["Source"]["main"][0][0]["node"], "Target")
        self.assertEqual(repairs[0]["kind"], "connection_source_port_normalized")
        self.assertEqual(repairs[0]["fromOutputIndex"], 1)
        self.assertEqual(repairs[0]["toOutputIndex"], 0)

    def test_does_not_guess_when_source_has_multiple_compatible_outputs(self):
        candidate = workflow("test.single", 0, "test.source_multi")
        candidate["connections"]["Source"]["main"] = [[], [], [{"node": "Target", "type": "main", "index": 0}]]
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            with self.assertRaisesRegex(ValueError, "has no output port 2"):
                validate_connection_ports(candidate)

    def test_does_not_guess_when_runtime_schema_cannot_confirm_source_outputs(self):
        candidate = workflow("test.single", 0, "test.source_unknown")
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            with self.assertRaisesRegex(ValueError, "cannot confirm source output ports"):
                validate_connection_ports(candidate)

    def test_does_not_guess_when_runtime_schema_has_multiple_compatible_inputs(self):
        candidate = workflow("test.multi", 2)
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            with self.assertRaisesRegex(ValueError, "connection-port validation failed"):
                validate_connection_ports(candidate)

        self.assertEqual(candidate["connections"]["Source"]["main"][0][0]["index"], 2)

    def test_reports_deidentified_context_for_a_blocking_connection(self):
        candidate = workflow("test.multi", 2)
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            with self.assertRaises(StructuredValidationError) as error:
                validate_connection_ports(candidate, include_repair_context=True)

        self.assertEqual(error.exception.safe_findings[0]["repairContext"], {
            "sourceNodeIndex": 0,
            "sourceNodeType": "test.source",
            "targetNodeIndex": 1,
            "targetNodeType": "test.multi",
            "connectionType": "main",
            "sourceOutputIndex": 0,
            "targetInputIndex": 2,
        })

    def test_leaves_an_already_valid_connection_unchanged(self):
        candidate = workflow("test.multi", 1)
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            repairs = validate_connection_ports(candidate)

        self.assertEqual(candidate["connections"]["Source"]["main"][0][0]["index"], 1)
        self.assertEqual(repairs, [])
    def test_does_not_guess_when_runtime_schema_cannot_confirm_inputs(self):
        candidate = workflow("test.unknown", 1)
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store(["main"])):
            with self.assertRaisesRegex(ValueError, "cannot confirm target input ports"):
                validate_connection_ports(candidate)

        self.assertEqual(candidate["connections"]["Source"]["main"][0][0]["index"], 1)


