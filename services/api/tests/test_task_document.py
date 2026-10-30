import json
from pathlib import Path

import pytest

from konsora_api.task_document import DocumentError, parse_document, serialize_document, task_fingerprint


def test_example_is_portable_and_roundtrips_without_sqlite():
    path = Path(__file__).resolve().parents[3] / "docs/examples/portable-project/.konsora/tasks.json"
    document = parse_document(path.read_bytes())
    assert [task.id for task in document.tasks] == ["T-001", "T-002"]
    assert parse_document(serialize_document(document)) == document
    before = task_fingerprint(document.tasks[0])
    document.tasks[0].description += " Cambio externo sin incrementar versión."
    assert task_fingerprint(document.tasks[0]) != before


@pytest.mark.parametrize("value", [
    {"schema_version": 2, "tasks": []},
    {"schema_version": True, "tasks": []},
    {"schema_version": 1, "tasks": [{"id": "a", "title": " "}]},
    {"schema_version": 1, "tasks": [{"id": "a", "title": "A"}, {"id": "a", "title": "B"}]},
    {"schema_version": 1, "tasks": [{"id": "a", "title": "A", "dependencies": ["a"]}]},
    {"schema_version": 1, "tasks": [{"id": "a", "title": "A", "dependencies": ["missing"]}]},
    {"schema_version": 1, "tasks": [{"id": "a", "title": "A", "dependencies": ["b"]}, {"id": "b", "title": "B", "dependencies": ["a"]}]},
])
def test_invalid_contracts_are_rejected(value):
    with pytest.raises(DocumentError):
        parse_document(json.dumps(value).encode())


@pytest.mark.parametrize("data", [b'{"schema_version":1,"tasks":[],"tasks":[]}', b'{"schema_version":', b'\xff', b'{"schema_version":1,"tasks":NaN}'])
def test_incomplete_duplicate_or_invalid_json_is_not_an_empty_board(data):
    with pytest.raises(DocumentError):
        parse_document(data)
