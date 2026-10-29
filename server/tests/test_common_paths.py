import unittest

from edith.common.paths import resolve


class PathsTest(unittest.TestCase):
    def test_defaults_are_the_live_locations(self):
        p = resolve(env={"HOME": "/home/ubuntu"})
        self.assertEqual(p.work_dir, "/home/ubuntu/edith")
        self.assertEqual(p.bridge_state, "/home/ubuntu/.cache/edith/bridge-state.json")
        self.assertEqual(p.perm_dir, "/home/ubuntu/.cache/edith/perms")
        self.assertEqual(p.reminders, "/home/ubuntu/.cache/edith/reminders.json")
        self.assertEqual(p.telegram_dir, "/home/ubuntu/.claude/channels/telegram")
        self.assertEqual(p.google_dir, "/home/ubuntu/.config/edith-google")
        self.assertEqual(p.inbox, "/home/ubuntu/edith/inbox")
        # Same rule as the legacy bridge's PROJECT_DIR.
        self.assertEqual(p.transcripts, "/home/ubuntu/.claude/projects/-home-ubuntu-edith")

    def test_staging_overrides(self):
        env = {"HOME": "/h", "EDITH_STATE_DIR": "~/.cache/edith-staging", "EDITH_WORK_DIR": "/h/edith-staging"}
        p = resolve(env=env)
        self.assertEqual(p.state_dir, "/h/.cache/edith-staging")
        self.assertEqual(p.perm_dir, "/h/.cache/edith-staging/perms")  # follows state_dir
        self.assertEqual(p.transcripts, "/h/.claude/projects/-h-edith-staging")

    def test_config_beats_env_and_perm_dir_can_move(self):
        env = {"HOME": "/h", "EDITH_STATE_DIR": "/env", "EDITH_PERM_DIR": "/perms"}
        p = resolve({"state_dir": "/cfg"}, env)
        self.assertEqual(p.state_dir, "/cfg")
        self.assertEqual(p.perm_dir, "/perms")


if __name__ == "__main__":
    unittest.main()
