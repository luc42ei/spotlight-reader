#!/bin/bash
# Produces the source package required by AMO review (reviewers can run
# tools/build.sh on its contents to reproduce the submitted extension zip).
set -e

OUT="../spotlight-reader-source.zip"
rm -f "$OUT"

zip -r "$OUT" . \
  --exclude "*.git*" \
  --exclude "node_modules/*" \
  -q

echo "Built source package: $OUT ($(du -sh "$OUT" | cut -f1))"
echo "Reviewers: unzip, then run 'bash tools/build.sh' to reproduce the extension package."
