#!/usr/bin/env python3
"""Manifest sanity for the litellm add-on: config.yaml declares the keys
the Supervisor store pipeline depends on, and the version stays plain
semver (repo rule: no prerelease/-N suffixes). Plain python3, text checks
only, following the conventions of test_package.py.
"""

import os
import re
import sys

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ADDON_DIR, "config.yaml"), encoding="utf-8") as fh:
    CONFIG = fh.read()


def test_manifest_has_name():
    assert re.search(r"^name:\s*\S", CONFIG, re.M), "config.yaml: no name:"


def test_manifest_version_is_plain_semver():
    pattern = r'^version:\s*"?(\d+\.\d+\.\d+)"?\s*$'
    assert re.search(pattern, CONFIG, re.M), "config.yaml: version must be plain semver"


def test_manifest_slug_matches_directory():
    slug = re.search(r'^slug:\s*"?(\S+?)"?\s*$', CONFIG, re.M)
    assert slug, "config.yaml: no slug:"
    assert slug.group(1) == os.path.basename(ADDON_DIR), "slug does not match directory name"


def main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok -", name)
            except AssertionError as err:
                failures += 1
                print("FAIL -", name, "-", err)
    print("%d failures" % failures)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
