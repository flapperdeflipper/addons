"""Explicit provider registry: add an adapter here to extend the proxy."""

import logging
import shutil
from collections.abc import Callable
from pathlib import Path

from storage import CredentialStore

from providers.base import Provider
from providers.claude import ClaudeProvider
from providers.zai import ZaiProvider

LOG = logging.getLogger(__name__)

PROVIDER_FACTORIES: dict[str, Callable[[CredentialStore], Provider]] = {
    "claude": ClaudeProvider,
    "zai": ZaiProvider,
}

# Providers an earlier release shipped. Nothing polls them any more, so their
# stored credentials are deleted at start instead of being left behind.
RETIRED_PROVIDERS = ("openai",)


def remove_retired_providers(root: Path) -> None:
    """Delete the private credentials of providers this add-on no longer ships."""
    for key in RETIRED_PROVIDERS:
        try:
            shutil.rmtree(root / "providers" / key)
        except FileNotFoundError:
            continue
        except OSError:
            LOG.warning("Could not remove the stored %s credentials", key)
        else:
            LOG.info("Removed the stored credentials of retired provider %s", key)


def create_providers(root: Path) -> dict[str, Provider]:
    remove_retired_providers(root)
    return {
        key: factory(CredentialStore(root, key))
        for key, factory in PROVIDER_FACTORIES.items()
    }
