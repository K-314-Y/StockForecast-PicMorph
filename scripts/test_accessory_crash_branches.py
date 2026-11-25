"""Run offline with python3 -B scripts/test_accessory_crash_branches.py."""
import unittest

import accessory_crash_branches as study


class ForkTests(unittest.TestCase):
    def test_replay_shared_shock_and_split_separation(self):
        seen_prefixes, seen_paths = set(), set()
        for split in study.SETS:
            for index in range(study.COUNT):
                shock, paths = study.family(split, index)
                self.assertEqual((shock, paths), study.family(split, index))
                self.assertEqual(tuple(paths), study.BRANCHES)
                prefix = paths["weak"][:shock + 1]
                self.assertNotIn(prefix, seen_prefixes)
                seen_prefixes.add(prefix)
                for path in paths.values():
                    self.assertEqual(len(path), 12)
                    self.assertEqual(path[:shock + 1], prefix)
                    self.assertNotIn(path, seen_paths)
                    seen_paths.add(path)
                mixed = paths["mixed"][shock:shock + 3]
                self.assertLess((mixed[1] - mixed[0]) * (mixed[2] - mixed[1]), 0)
                decline = paths["decline"][shock:]
                self.assertTrue(all(a > b for a, b in zip(decline, decline[1:])))
                double = paths["double"][shock:]
                self.assertEqual(sum(b / a < 0.95 for a, b in zip(double, double[1:])), 1)

    def test_every_shared_observation_has_same_next_decision(self):
        for split in study.SETS:
            for index in range(study.COUNT):
                shock, paths = study.family(split, index)
                known = {}
                for path in paths.values():
                    for name, plan in study.ai_plans(path).items():
                        for day, step in enumerate(plan["signals"]):
                            key = name, path[:day]  # excludes today's close
                            self.assertEqual(known.setdefault(key, step), step)
                # All branches share the decision made at the crash close.
                for name in ("glasses", "standard", "triple"):
                    self.assertIn((name, paths["weak"][:shock + 1]), known)

    def test_changed_unseen_suffix_at_every_decision(self):
        _, paths = study.family("validation", 0)
        for path in paths.values():
            original = study.ai_plans(path)
            for day in range(12):
                suffix = tuple(60 + j * 15 for j in range(12 - day))
                for name, plan in study.ai_plans(path[:day] + suffix).items():
                    self.assertEqual(plan["signals"][:day + 1], original[name]["signals"][:day + 1])


if __name__ == "__main__":
    unittest.main()
