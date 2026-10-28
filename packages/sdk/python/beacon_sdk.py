"""beacon-sdk for Python scripts. Copy this file next to your script (or add it to PYTHONPATH).

    from beacon_sdk import emit, notify, progress
"""
import json
import sys

_PREFIX = "@@beacon "


def _send(msg):
    sys.stdout.write(_PREFIX + json.dumps(msg) + "\n")
    sys.stdout.flush()


def emit(title, subtitle=None, icon=None, value=None, action=None):
    """List mode: print one result item (JSON Lines)."""
    item = {"title": title}
    for k, v in (("subtitle", subtitle), ("icon", icon), ("value", value), ("action", action)):
        if v is not None:
            item[k] = v
    sys.stdout.write(json.dumps(item) + "\n")
    sys.stdout.flush()


def notify(title, body=None):
    """Show a local notification."""
    _send({"type": "notify", "title": title, **({"body": body} if body else {})})


def progress(value, label=None):
    """Update the progress bar (0..1) and optional label in the launcher."""
    _send({"type": "progress", "value": value, **({"label": label} if label else {})})
