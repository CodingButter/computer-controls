"""The skill commons suite, as a package.

The `__init__.py` is not decoration. Without it these modules are imported by
their bare names, and this directory's `conftest` becomes *the* `conftest` for
whoever imports one first — which the service's own live-gate tests do by name,
because the gate they are testing is the one at the root. A suite that quietly
answered for the root conftest would fail nineteen tests in another package and
name none of its own files in the traceback.
"""
