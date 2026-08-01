"""The Mastra Code desktop control service.

A JSON-RPC service that exposes a Linux desktop semantically — applications,
windows and elements — over a Unix socket. See `service/README.md` for the
threading contract, which every module here obeys.
"""

from .capabilities import PROTOCOL_VERSION

__all__ = ["PROTOCOL_VERSION"]
