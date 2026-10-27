"""Private, atomic per-provider credential storage."""

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


def private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


class CredentialStore:
    def __init__(self, root: Path, provider_id: str) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9_]*", provider_id):
            raise ValueError("Invalid provider ID")
        self.root = root
        self.directory = private_directory(root / "providers" / provider_id)
        self.path = self.directory / "credentials.json"

    def read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        if not isinstance(data, dict):
            raise TypeError("Credential file must contain an object")
        return data

    def write(self, value: dict[str, Any]) -> None:
        fd, name = tempfile.mkstemp(prefix=".credentials-", dir=self.directory)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(value, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(name, self.path)
        finally:
            Path(name).unlink(missing_ok=True)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)

    def migrate_claude(self) -> None:
        legacy = self.root / "tokens.json"
        if not legacy.exists():
            return
        if not self.path.exists():
            value = json.loads(legacy.read_text())
            if not isinstance(value, dict) or not isinstance(
                value.get("refresh_token"), str
            ):
                raise ValueError("Invalid legacy Claude credentials")
            self.write(value)
        legacy.chmod(0o600)
        legacy.replace(self.root / "tokens.json.migrated")
