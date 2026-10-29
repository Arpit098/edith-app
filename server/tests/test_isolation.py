"""Import rules that keep features independent (see docs/ARCHITECTURE.md).

- features/<x> may import edith.core, edith.ports, edith.common, and its own package only.
- adapters may import edith.core, edith.ports, edith.common, never edith.features.
- common may import edith.core only.
- core and ports never import features, adapters or common.
"""
import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1] / "edith"


def edith_imports(path: pathlib.Path) -> set[str]:
    """Absolute edith.* modules imported by a file (relative imports resolved)."""
    pkg = path.relative_to(ROOT.parent).with_suffix("").parts
    pkg = pkg[:-1] if pkg[-1] != "__init__" else pkg[:-1]
    found = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            found |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = pkg[:len(pkg) - node.level + 1] if node.level > 1 else pkg
                found.add(".".join(base + ((node.module,) if node.module else ())))
            elif node.module:
                found.add(node.module)
    return {m for m in found if m == "edith" or m.startswith("edith.")}


class IsolationTest(unittest.TestCase):
    def check(self, glob, allowed):
        problems = []
        for path in ROOT.glob(glob):
            parts = path.relative_to(ROOT.parent).parts
            own = ".".join(parts[:3] if parts[1] in ("features", "adapters") else parts[:2])
            for mod in edith_imports(path):
                if mod.startswith(own) or any(mod == a or mod.startswith(a + ".") for a in allowed):
                    continue
                problems.append(f"{path.relative_to(ROOT.parent)} imports {mod}")
        self.assertEqual(problems, [], "\n".join(problems))

    def test_features(self):
        self.check("features/*/**/*.py", ["edith.core", "edith.ports", "edith.common"])

    def test_adapters(self):
        self.check("adapters/**/*.py", ["edith.core", "edith.ports", "edith.common", "edith.adapters"])

    def test_common(self):
        self.check("common/**/*.py", ["edith.core"])

    def test_core_and_ports(self):
        self.check("core/**/*.py", [])
        self.check("ports/**/*.py", ["edith.core"])


if __name__ == "__main__":
    unittest.main()
