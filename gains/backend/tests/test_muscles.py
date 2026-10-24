"""Validate the portable catalog without requiring a Home Assistant runtime."""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).parents[1] / "gains_addon"
CATALOG = json.loads((ROOT / "muscles.json").read_text())
TREE = ast.parse((ROOT / "exercises.py").read_text())
LIBRARY = next(ast.literal_eval(node.value) for node in TREE.body
               if isinstance(node, ast.AnnAssign)
               and isinstance(node.target, ast.Name)
               and node.target.id == "EXERCISE_LIBRARY")


def test_catalog_roles_are_known_unique_and_disjoint():
    assert CATALOG["catalogVersion"]
    for roles in CATALOG["exercises"].values():
        assert roles["primary"]
        for role in ("primary", "secondary"):
            assert len(roles[role]) == len(set(roles[role]))
            assert set(roles[role]) <= CATALOG["muscles"].keys()
        assert not set(roles["primary"]) & set(roles["secondary"])


def test_catalog_covers_strength_without_inventing_exercise_ids():
    ids = {exercise["id"] for exercise in LIBRARY}
    assert CATALOG["exercises"].keys() <= ids
    assert {exercise["id"] for exercise in LIBRARY
            if exercise["category"] != "mobility"} <= CATALOG["exercises"].keys()
