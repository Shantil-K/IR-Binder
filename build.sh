#!/bin/sh
# Build the .ipk from src/ (needs the webOS CLI: npm i -g @webos-tools/cli)
# Install on the TV with:  ares-install -d <your-tv> dist/com.anymote.irbind_<version>_all.ipk
set -e
cd "$(dirname "$0")"
rm -rf dist
mkdir -p dist
chmod +x src/daemon/*.sh
ares-package src -o dist
ls -l dist
