#!/bin/bash
set -e

OUT="../spotlight-reader.zip"
rm -f "$OUT"

zip -r "$OUT" . \
  --exclude "*.git*" \
  --exclude "docs/*" \
  --exclude "tools/*" \
  --exclude "package.json" \
  --exclude "package-lock.json" \
  --exclude "introduction.md" \
  --exclude "README.md" \
  --exclude "updates.json" \
  --exclude "*.xcf" \
  --exclude "img/Bildschirmfoto*" \
  -q

echo "Built: $OUT ($(du -sh "$OUT" | cut -f1))"
