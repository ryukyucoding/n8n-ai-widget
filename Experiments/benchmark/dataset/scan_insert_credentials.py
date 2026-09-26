#!/usr/bin/env python3
"""
Scan insert benchmark cases for credential / Cloud AI setup risk.

The n8n Cloud AI Builder post-build wizard walks incomplete nodes in the *base*
workflow (not only the inserted node). Cases with zero credential nodes in
base.json are much less likely to burn time/credits on Execute-step setup.

Usage:
  python3 scan_insert_credentials.py
  python3 scan_insert_credentials.py --tier A --ids-only
  python3 scan_insert_credentials.py --write-manifest-slice data/insert_cloud_tier_a.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

JSONDict = Dict[str, Any]

BENCHMARK_ROOT = Path(__file__).resolve().parent.parent
INSERT_DIR = BENCHMARK_ROOT / "data" / "insert"
DEFAULT_OUT = BENCHMARK_ROOT / "data" / "insert_credential_scan.json"
MANIFEST_PATH = BENCHMARK_ROOT / "data" / "manifest.json"

NO_CRED_SUFFIXES = (
    ".stickyNote",
    ".code",
    ".set",
    ".if",
    ".switch",
    ".merge",
    ".noOp",
    ".wait",
    ".filter",
    ".splitOut",
    ".splitInBatches",
    ".removeDuplicates",
    ".manualTrigger",
    ".scheduleTrigger",
    ".webhook",
    ".respondToWebhook",
    ".aggregate",
    ".limit",
    ".sort",
    ".renameKeys",
    ".crypto",
    ".dateTime",
    ".compareDatasets",
    ".itemLists",
    ".executeWorkflowTrigger",
    ".stopAndError",
    ".html",
    ".xml",
    ".markdown",
    ".function",
    ".functionItem",
)

NO_CRED_EXACT = {
    "n8n-nodes-base.stickyNote",
    "n8n-nodes-base.code",
    "n8n-nodes-base.set",
    "n8n-nodes-base.if",
    "n8n-nodes-base.switch",
    "n8n-nodes-base.merge",
    "n8n-nodes-base.noOp",
    "n8n-nodes-base.wait",
    "n8n-nodes-base.filter",
    "n8n-nodes-base.manualTrigger",
    "n8n-nodes-base.scheduleTrigger",
    "n8n-nodes-base.webhook",
    "n8n-nodes-base.respondToWebhook",
    "n8n-nodes-base.form",
    "n8n-nodes-base.formTrigger",
    "@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter",
    "@n8n/n8n-nodes-langchain.documentDefaultDataLoader",
    "@n8n/n8n-nodes-langchain.memoryBufferWindow",
}

TIER_ORDER = ("A2", "A", "B", "C", "D")

INTEGRATION_TYPE_KEYS = (
    "googlesheets",
    "gmail",
    "github",
    "slack",
    "telegram",
    "microsoftoutlook",
    "microsoftsharepoint",
    "postgres",
    "mysql",
    "mongo",
    "openai",
    "lmchat",
    "embeddingsopenai",
    "vectorstore",
    "airtable",
    "notion",
    "facebookgraphapi",
    "graphapi",
    "n8n-nodes-base.n8n",
    "agent",
    "chainretrieval",
    "googlegemini",
    "googlepalm",
    "supabase",
    "pinecone",
    "qdrant",
    "hubspot",
    "salesforce",
    "httprequest",
    "calendly",
    "twilio",
    "brevo",
    "mailchimp",
    "stripe",
)

SAFE_NODE_SUFFIXES = (
    ".code",
    ".set",
    ".if",
    ".switch",
    ".merge",
    ".noOp",
    ".wait",
    ".filter",
    ".splitOut",
    ".splitInBatches",
    ".removeDuplicates",
    ".stickyNote",
    ".manualTrigger",
    ".scheduleTrigger",
    ".webhook",
    ".respondToWebhook",
    ".formTrigger",
    ".executeWorkflowTrigger",
    ".aggregate",
    ".limit",
    ".sort",
    ".html",
    ".xml",
    ".crypto",
    ".dateTime",
    ".itemLists",
    ".compareDatasets",
)


def is_integration_node_type(node_type: str) -> bool:
    """Node types that usually trigger Cloud credential / execute-step setup."""
    if not node_type:
        return False
    if any(node_type.endswith(suffix) for suffix in SAFE_NODE_SUFFIXES):
        return False
    tl = node_type.lower()
    return any(key in tl for key in INTEGRATION_TYPE_KEYS)


def type_unlikely_needs_credential(node_type: str) -> bool:
    if not node_type:
        return False
    if node_type in NO_CRED_EXACT:
        return True
    return any(node_type.endswith(suffix) for suffix in NO_CRED_SUFFIXES)


def nodes_with_credentials(wf: JSONDict) -> List[JSONDict]:
    rows: List[JSONDict] = []
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        creds = node.get("credentials")
        if not creds:
            continue
        rows.append(
            {
                "name": node.get("name"),
                "type": node.get("type"),
                "credential_types": sorted(creds.keys()) if isinstance(creds, dict) else [],
            }
        )
    return rows


def inserted_node(base: JSONDict, gold: JSONDict) -> Optional[JSONDict]:
    base_names = {
        n.get("name")
        for n in base.get("nodes") or []
        if isinstance(n, dict) and n.get("name")
    }
    for node in gold.get("nodes") or []:
        if isinstance(node, dict) and node.get("name") not in base_names:
            return node
    return None


def integration_nodes_in_workflow(wf: JSONDict) -> List[JSONDict]:
    rows: List[JSONDict] = []
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_type = str(node.get("type") or "")
        if is_integration_node_type(node_type):
            rows.append({"name": node.get("name"), "type": node_type})
    return rows


def classify_case(case_id: str, base: JSONDict, gold: JSONDict) -> JSONDict:
    base_creds = nodes_with_credentials(base)
    base_integrations = integration_nodes_in_workflow(base)
    ins = inserted_node(base, gold)
    inserted_type = ins.get("type") if ins else None
    inserted_has_cred = bool(ins and ins.get("credentials"))
    inserted_safe = type_unlikely_needs_credential(str(inserted_type or ""))
    inserted_is_integration = is_integration_node_type(str(inserted_type or ""))
    base_cred_count = len(base_creds)
    base_integration_count = len(base_integrations)
    clean_base = base_cred_count == 0

    cloud_friendly = clean_base and inserted_safe and not inserted_has_cred
    strict_cloud = (
        base_integration_count == 0 and inserted_safe and not inserted_is_integration
    )

    if strict_cloud:
        tier = "A2"
        tier_label = "strict_no_integration_nodes"
    elif cloud_friendly:
        tier = "A"
        tier_label = "cloud_friendly"
    elif clean_base:
        tier = "B"
        tier_label = "clean_base"
    elif base_cred_count <= 1 and inserted_safe and not inserted_has_cred:
        tier = "C"
        tier_label = "low_base_insert_safe"
    elif inserted_safe and not inserted_has_cred:
        tier = "D"
        tier_label = "insert_safe_only"
    else:
        tier = "X"
        tier_label = "high_setup_risk"

    return {
        "id": case_id,
        "tier": tier,
        "tier_label": tier_label,
        "base_credential_node_count": base_cred_count,
        "base_credential_nodes": base_creds,
        "base_integration_node_count": base_integration_count,
        "base_integration_nodes": base_integrations,
        "inserted_node_name": ins.get("name") if ins else None,
        "inserted_node_type": inserted_type,
        "inserted_has_credentials": inserted_has_cred,
        "inserted_type_unlikely_needs_credential": inserted_safe,
        "inserted_is_integration_type": inserted_is_integration,
        "cloud_friendly": cloud_friendly,
        "strict_cloud": strict_cloud,
        "recommended_for_cloud": tier in ("A2", "A", "B", "C"),
        "caveat": (
            "Tier A only means no credentials{} in base JSON (often stripped on import). "
            "Canvas may still show Gmail/Telegram/Facebook nodes needing setup. "
            "Use tier A2 to avoid integration node types entirely."
        ),
    }


def scan_insert_full() -> List[JSONDict]:
    rows: List[JSONDict] = []
    for case_dir in sorted(INSERT_DIR.iterdir()):
        if not case_dir.is_dir() or not case_dir.name.startswith("insert-full-"):
            continue
        base = json.loads((case_dir / "base.json").read_text(encoding="utf-8"))
        gold = json.loads((case_dir / "gold.json").read_text(encoding="utf-8"))
        rows.append(classify_case(case_dir.name, base, gold))
    return rows


def summarize(cases: List[JSONDict]) -> JSONDict:
    by_tier: JSONDict = {t: [] for t in (*TIER_ORDER, "X")}
    for row in cases:
        by_tier.setdefault(row["tier"], []).append(row["id"])
    return {
        "total_insert_full": len(cases),
        "tier_counts": {t: len(by_tier.get(t, [])) for t in (*TIER_ORDER, "X")},
        "tier_case_ids": by_tier,
        "cloud_friendly_count": sum(1 for r in cases if r["cloud_friendly"]),
    }


def write_manifest_slice(case_ids: List[str], out_path: Path) -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    wanted = set(case_ids)
    picked = [c for c in manifest.get("cases", []) if c.get("id") in wanted]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "profile": manifest.get("profile"),
                "source_manifest": str(MANIFEST_PATH),
                "credential_filter": sorted(wanted),
                "cases": picked,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan insert-full cases for credential setup risk")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--tier", choices=[*TIER_ORDER, "recommended"], help="Print case ids for one tier")
    ap.add_argument("--ids-only", action="store_true")
    ap.add_argument(
        "--write-manifest-slice",
        type=Path,
        help="Write manifest subset JSON for cases matching --tier (requires --tier)",
    )
    args = ap.parse_args()

    cases = scan_insert_full()
    summary = summarize(cases)
    payload = {
        "summary": summary,
        "tier_definitions": {
            "A2": "base has zero integration-type nodes (strict); insert is Code/Set/If/…",
            "A": "base has 0 credentials{} in JSON; insert safe (may still have Gmail/FB nodes on canvas)",
            "B": "base has 0 credentials{} in JSON (insert may be API/DB type)",
            "C": "base has ≤1 credentials{} node; inserted node insert-safe",
            "D": "inserted node insert-safe; base may have many integration nodes",
            "X": "high setup risk — expect credential / execute-step wizard",
        },
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.tier:
        if args.tier == "recommended":
            ids = [r["id"] for r in cases if r["tier"] in ("A2", "A", "B", "C")]
        else:
            ids = summary["tier_case_ids"].get(args.tier, [])
        if args.write_manifest_slice:
            write_manifest_slice(ids, args.write_manifest_slice)
            print(f"Wrote {len(ids)} cases to {args.write_manifest_slice}")
        if args.ids_only:
            for cid in ids:
                print(cid)
        else:
            print(json.dumps(ids, ensure_ascii=False, indent=2))
        return 0

    print(f"Wrote {args.out}")
    print(json.dumps(summary["tier_counts"], indent=2))
    print("\nTier A (cloud_friendly):")
    for cid in summary["tier_case_ids"].get("A", []):
        row = next(r for r in cases if r["id"] == cid)
        print(f"  {cid}  insert={row['inserted_node_name']} ({row['inserted_node_type']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
