"""Toolkit bindings live here and nowhere else.

Every `import gi` in this service is inside this package. Modules outside it talk
to the desktop only through the functions exported here, which keeps the single
GLib-thread contract enforceable by inspection: if no other module can reach a
binding, no other module can call one from the wrong thread.
"""
