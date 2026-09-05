#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
    exec python3 "$DIR/host.py"
elif command -v python >/dev/null 2>&1; then
    exec python "$DIR/host.py"
elif command -v node >/dev/null 2>&1; then
    exec node "$DIR/host.js"
else
    echo "Python / Node.js tidak ditemukan." >&2
    exit 1
fi
