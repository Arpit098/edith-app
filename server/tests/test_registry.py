"""A broken feature must not affect the others."""
import sys
import types
import unittest

from edith.core import Event, EventBus, Feature, Ports, Registry, load_features


def fake_feature(name, setup):
    module = types.ModuleType(f"fakefeatures.{name}")
    module.FEATURE = Feature(name=name, setup=setup)
    sys.modules[module.__name__] = module


class RegistryTest(unittest.TestCase):
    def setUp(self):
        sys.modules["fakefeatures"] = types.ModuleType("fakefeatures")
        self.bus, self.registry = EventBus(), Registry()

    def load(self, names):
        return load_features(names, self.bus, Ports(), self.registry, {}, package="fakefeatures")

    def test_failing_feature_is_isolated_and_rolled_back(self):
        seen = []

        def good(ctx):
            ctx.add_command("good", "ok", lambda call: "ok")
            ctx.subscribe("turn.done", lambda ev: seen.append("good"))

        def bad(ctx):
            ctx.add_command("bad", "half-registered", lambda call: "x")
            ctx.subscribe("turn.done", lambda ev: seen.append("bad"))
            raise RuntimeError("boom")

        fake_feature("good", good)
        fake_feature("bad", bad)
        report = self.load(["bad", "good", "missing"])

        self.assertEqual(report.loaded, ["good"])
        self.assertEqual(set(report.failed), {"bad", "missing"})
        self.assertEqual(set(self.registry.commands), {"good"})
        self.bus.publish(Event("turn.done"))
        self.assertEqual(seen, ["good"])

    def test_failing_handler_does_not_block_others(self):
        seen = []
        self.bus.subscribe("turn.*", lambda ev: 1 / 0, owner="a")
        self.bus.subscribe("turn.*", lambda ev: seen.append(ev.type), owner="b")
        self.bus.publish(Event("turn.done"))
        self.assertEqual(seen, ["turn.done"])

    def test_duplicate_command_is_rejected(self):
        fake_feature("one", lambda ctx: ctx.add_command("dup", "", lambda c: None))
        fake_feature("two", lambda ctx: ctx.add_command("dup", "", lambda c: None))
        report = self.load(["one", "two"])
        self.assertEqual(report.loaded, ["one"])
        self.assertIn("two", report.failed)

    def test_template_feature_loads(self):
        report = load_features(["_template"], self.bus, Ports(), self.registry, {})
        self.assertEqual(report.loaded, ["_template"])
        self.assertIn("ping", self.registry.commands)


if __name__ == "__main__":
    unittest.main()
