"""The server layer — the middle process between network clients and the daemon.

Sits between a phone/browser PWA (which holds only a server URL + credential)
and the desktop daemon (which owns AT-SPI, X11, capture, consent, holds and
presence over a local ``0600`` unix socket). The server is the *only* process
that opens that socket, and it opens one connection per agent — the #34
invariant. See ``transport.py`` for why that rule is load-bearing.
"""
