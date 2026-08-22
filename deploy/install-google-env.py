#!/usr/bin/env python3
"""Install Google OAuth values from stdin without echoing them."""

import json
import os
import tempfile
import sys


ENV_FILE = "/etc/apocrypha.env"
ALLOWED = {
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_DOC_ID",
}


def main():
    incoming = json.load(sys.stdin)
    if set(incoming) != ALLOWED or not all(isinstance(value, str) and value for value in incoming.values()):
        raise SystemExit("Expected exactly four non-empty Google environment values.")

    values = {}
    order = []
    with open(ENV_FILE, encoding="utf-8") as source:
        for raw in source:
            line = raw.rstrip("\n")
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if key not in values:
                order.append(key)
            values[key] = value

    for key, value in incoming.items():
        if key not in values:
            order.append(key)
        values[key] = value

    descriptor, temporary = tempfile.mkstemp(prefix=".apocrypha.env.", dir="/etc", text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
            for key in order:
                destination.write(f"{key}={values[key]}\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(temporary, 0o600)
        os.chown(temporary, 0, 0)
        os.replace(temporary, ENV_FILE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
