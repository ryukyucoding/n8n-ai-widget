from __future__ import annotations

import json
import subprocess
import sys
import types
import unittest
from pathlib import Path

sys.modules.setdefault("json_repair", types.SimpleNamespace(repair_json=lambda value: value))

PYTHON_ROOT = Path(__file__).resolve().parents[1]
CHATBOT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PYTHON_ROOT))

from workflow_repair import normalize_workflow_structure, validate_connection_ports, validate_node_parameters  # noqa: E402

FIXTURE_PATH = CHATBOT_ROOT / "tests" / "createFixtures" / "C01.workflow.template.json"


class C01RuntimeSchemaFixtureTests(unittest.TestCase):
    def test_compiled_c01_payload_passes_the_offline_runtime_schema_fixture(self) -> None:
        result = subprocess.run(
            ["node", "-e", "const {toProvisionWorkflow}=require('./tests/createFixtures/c01FixtureIntegrity'); process.stdout.write(JSON.stringify(toProvisionWorkflow()));"],
            cwd=CHATBOT_ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        workflow = json.loads(result.stdout)
        normalize_workflow_structure(workflow)
        validate_node_parameters(workflow)
        self.assertEqual(validate_connection_ports(workflow), [])


if __name__ == "__main__":
    unittest.main()
