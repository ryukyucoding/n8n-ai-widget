import sys
import unittest
from unittest.mock import patch
import types
from pathlib import Path
json_repair_stub = types.ModuleType("json_repair")
json_repair_stub.repair_json = lambda raw: raw
sys.modules.setdefault("json_repair", json_repair_stub)


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workflow_repair import RuntimeSchemaStore, validate_node_parameters  # noqa: E402


def schema_store() -> RuntimeSchemaStore:
    store = RuntimeSchemaStore.__new__(RuntimeSchemaStore)
    store.schemas = {
        "n8n-nodes-base.code": {"versions": {"1": {"displayName": "Code"}}},
        "n8n-nodes-base.webhook": {"versions": {"1": {"displayName": "Webhook"}}},
        "n8n-nodes-base.scheduleTrigger": {"versions": {"1": {"displayName": "Schedule"}}},
    }
    return store


class NodeIntentClassificationTests(unittest.TestCase):
    def test_chinese_required_and_forbidden_nodes(self) -> None:
        required, forbidden = schema_store().classify_named_types(
            "使用 Code，不得使用 Webhook 或 Schedule"
        )
        self.assertEqual(required, {"n8n-nodes-base.code"})
        self.assertEqual(
            forbidden,
            {"n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger"},
        )

    def test_english_positive_webhook_is_required(self) -> None:
        required, forbidden = schema_store().classify_named_types("Create workflow with Webhook")
        self.assertEqual(required, {"n8n-nodes-base.webhook"})
        self.assertEqual(forbidden, set())

    def test_english_negative_forms_are_forbidden(self) -> None:
        required, forbidden = schema_store().classify_named_types(
            "Use Code, do not use Webhook and without Schedule"
        )
        self.assertEqual(required, {"n8n-nodes-base.code"})
        self.assertEqual(
            forbidden,
            {"n8n-nodes-base.webhook", "n8n-nodes-base.scheduleTrigger"},
        )

    def test_validator_rejects_missing_required_and_present_forbidden_types(self) -> None:
        required_workflow = {"nodes": [{"name": "Code", "type": "n8n-nodes-base.code", "typeVersion": 1, "parameters": {}}]}
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store()):
            with self.assertRaisesRegex(ValueError, "requires runtime node"):
                validate_node_parameters(required_workflow, "Create workflow with Webhook")

        forbidden_workflow = {"nodes": [{"name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 1, "parameters": {}}]}
        with patch("workflow_repair.RuntimeSchemaStore", return_value=schema_store()):
            with self.assertRaisesRegex(ValueError, "forbids runtime node"):
                validate_node_parameters(forbidden_workflow, "Do not use Webhook")


if __name__ == "__main__":
    unittest.main()
