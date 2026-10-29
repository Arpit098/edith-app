"""Shared helpers used by more than one feature or adapter.

Rules (enforced by tests/test_isolation.py):
- common may import edith.core and the standard library, never edith.features or edith.adapters.
- Put something here only once a second feature or adapter needs it; until then, keep it in its feature.
"""
