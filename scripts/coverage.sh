#!/usr/bin/env bash
# Runs every workspace's tests with coverage and writes one LCOV report.
#
#   scripts/coverage.sh
#
# Output: coverage/lcov.info, with paths relative to the repo root, for the apps, the modules
# and packages/core together. Node reports the files the tests load, so the two server entry
# points (apps/*/src/index.js) and legacy/ are not in it: nothing loads them.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p coverage

node --test \
  --experimental-test-coverage \
  --test-coverage-exclude="**/test/**" \
  --test-coverage-exclude="**/node_modules/**" \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
  --test-reporter=spec --test-reporter-destination=stdout \
  "apps/*/test/*.test.js" "modules/*/test/*.test.js" "packages/*/test/*.test.js"

# Forward slashes whatever machine produced it.
tr '\\' '/' < coverage/lcov.info > coverage/lcov.tmp && mv coverage/lcov.tmp coverage/lcov.info

echo "coverage/lcov.info written: $(grep -c '^SF:' coverage/lcov.info) files"
