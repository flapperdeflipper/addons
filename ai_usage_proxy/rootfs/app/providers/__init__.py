"""Explicit provider registry: add an adapter here to extend the proxy."""

from collections.abc import Callable
from pathlib import Path

from storage import CredentialStore

from providers.base import Provider
from providers.claude import ClaudeProvider
from providers.openai import OpenAIProvider
from providers.zai import ZaiProvider

PROVIDER_FACTORIES: dict[str, Callable[[CredentialStore], Provider]] = {
    "claude": ClaudeProvider,
    "openai": OpenAIProvider,
    "zai": ZaiProvider,
}


def create_providers(root: Path) -> dict[str, Provider]:
    return {
        key: factory(CredentialStore(root, key))
        for key, factory in PROVIDER_FACTORIES.items()
    }
