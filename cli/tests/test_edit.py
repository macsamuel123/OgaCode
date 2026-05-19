"""Quick smoke test for the new file_edit 'edit' action."""
from pathlib import Path
import tempfile
from ogacode.tools.file_edit import FileEditTool


def make(tmp: str) -> FileEditTool:
    return FileEditTool(Path(tmp))


def test_edit_replaces_unique_string():
    with tempfile.TemporaryDirectory() as tmp:
        tool = make(tmp)
        tool.execute(action="create", path="app.py",
                     content='def hello():\n    return "world"\n')
        r = tool.execute(action="edit", path="app.py",
                         old_string='    return "world"',
                         new_string='    return "Hello, OgaCode!"')
        assert r.success
        text = (Path(tmp) / "app.py").read_text()
        assert "Hello, OgaCode!" in text
        assert "world" not in text


def test_edit_fails_on_ambiguous_match():
    with tempfile.TemporaryDirectory() as tmp:
        tool = make(tmp)
        tool.execute(action="create", path="dupe.py", content="x = 1\nx = 1\n")
        r = tool.execute(action="edit", path="dupe.py",
                         old_string="x = 1", new_string="x = 2")
        assert not r.success
        assert "2" in r.error  # "matches 2 locations"


def test_edit_fails_when_string_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        tool = make(tmp)
        tool.execute(action="create", path="app.py", content="x = 1\n")
        r = tool.execute(action="edit", path="app.py",
                         old_string="not here", new_string="anything")
        assert not r.success
        assert "not found" in r.error


def test_edit_snapshots_before_change():
    with tempfile.TemporaryDirectory() as tmp:
        tool = make(tmp)
        tool.execute(action="create", path="app.py", content="original\n")
        tool.execute(action="edit", path="app.py",
                     old_string="original", new_string="changed")
        snaps = list((Path(tmp) / ".ogacode" / "snapshots").glob("app.py.*.bak"))
        assert len(snaps) == 1
        assert snaps[0].read_text() == "original\n"


def test_edit_delete_string():
    with tempfile.TemporaryDirectory() as tmp:
        tool = make(tmp)
        tool.execute(action="create", path="app.py",
                     content="keep this\ndelete this\nkeep this too\n")
        r = tool.execute(action="edit", path="app.py",
                         old_string="delete this\n", new_string="")
        assert r.success
        text = (Path(tmp) / "app.py").read_text()
        assert "delete this" not in text
        assert "keep this" in text
