#!/bin/bash
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  python3 launcher/server.py
else
  echo "Unmix needs Python 3 to run its local server."
  echo "macOS will offer to install the Command Line Tools - click Install, then run this again."
  xcode-select --install 2>/dev/null
  read -n 1 -s -r -p "Press any key to close"
fi
