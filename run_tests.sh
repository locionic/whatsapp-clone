#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ./.venv/bin/python ]; then
  echo "no venv: python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# Invoke pytest as a module so this works whether or not the console
# scripts got installed into .venv/bin (e.g. after a partial/rebuilt venv).
exec ./.venv/bin/python -m pytest -q djchat "$@"
