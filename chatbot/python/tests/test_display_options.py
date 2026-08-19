import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from workflow_repair import _is_applicable  # noqa: E402


class DisplayOptionConditionTests(unittest.TestCase):
    def test_applies_version_comparator_for_matching_resource_and_operation(self):
        definition = {
            "displayOptions": {
                "show": {
                    "@version": [{"_cnd": {"gte": 1.2}}],
                    "resource": ["text"],
                    "operation": ["message"],
                }
            }
        }
        parameters = {"resource": "text", "operation": "message"}
        self.assertTrue(_is_applicable(definition, parameters, 1.2))
        self.assertFalse(_is_applicable(definition, parameters, 1.1))

    def test_does_not_apply_when_a_version_comparator_is_not_satisfied(self):
        definition = {
            "displayOptions": {"show": {"@version": [{"_cnd": {"lt": 1.2}}]}}
        }
        self.assertTrue(_is_applicable(definition, {}, 1.1))
        self.assertFalse(_is_applicable(definition, {}, 1.2))
