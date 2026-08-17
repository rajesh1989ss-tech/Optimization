#!/bin/sh
# Crew Chat — start the local Wi-Fi messaging hub on macOS/Linux.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Install it once from https://nodejs.org"
  echo "  while you still have internet, then run this again."
  echo
  exit 1
fi
exec node server.js "$@"
