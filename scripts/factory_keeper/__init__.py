"""The keeper that re-wakes stalled Factory runs, and the gates that stop it
re-waking work that has already finished.

``gates`` is arithmetic and holds the whole decision. ``keeper`` is the thin
layer that reads rows and writes them back. ``reconcile`` is the one-shot that
retires rows the gates would refuse forever.
"""
