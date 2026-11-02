"""Read-only bridge from a saved *practice-only* training version to Node.

No training, file writes, HTTP, shell execution or user-supplied model values.
The immutable version must still match its draft, parameters, and fixed dataset.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import blueprints
import training_lab
from engine import SYNTHETIC_PRICES


def resolve_version(version_id: str) -> dict:
    if not isinstance(version_id, str) or not re.fullmatch(r"tv_[0-9a-f]{32}", version_id):
        raise ValueError("invalid_version_id")
    records = training_lab._read()["versions"]  # validated, read-only, atomic source
    versions = [entry for entry in records if entry.get("id") == version_id]
    if len(versions) != 1:
        raise ValueError("unknown_training_version")
    version = versions[0]
    if version["status"] != "practice_only" or version["competition_eligible"] is not False:
        raise ValueError("not_practice_only")
    source_id = blueprints.validate_id(version["source_draft_id"])
    draft = blueprints.read_drafts(source_id)["draft"]
    if training_lab.digest(draft) != version["source_draft_sha256"]:
        raise ValueError("draft_changed")
    model = training_lab.model_from_parameters(version["engine_parameters"])
    params = training_lab.parameters(model)
    if (training_lab.digest(params) != version["parameters_sha256"]
        or version["trained_until"] != 32
        or version["dataset_sha256"] != training_lab.digest(SYNTHETIC_PRICES)):
        raise ValueError("trained_version_integrity_failure")
    return {"version_id": version_id, "source_draft_id": source_id,
            "parameters_sha256": version["parameters_sha256"],
            "model": params, "kind": "trained_practice_only"}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("invalid_arguments")
        print(json.dumps(resolve_version(sys.argv[1]), allow_nan=False))
    except (ValueError, KeyError, TypeError, OSError, blueprints.BlueprintError) as error:
        print(f"Saved practice model rejected: {error}", file=sys.stderr)
        sys.exit(1)
