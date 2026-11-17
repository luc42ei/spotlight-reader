#!/bin/bash
# Submits a new listed version to addons.mozilla.org (tools/release.md steps 3–4).
#   bash tools/amo-submit.sh --dry-run          AMO validation only, no version is created
#   bash tools/amo-submit.sh "<release notes>"  upload version + source zip + en-US release
#                                               notes + reviewer notes (tools/LISTING.md §2)
# Keys come from amo.env in the repo root (JWT_ISSUER, JWT_KEY); never committed, never printed.
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

ADDON_ID="read-aloud-fork@lucaseichhorn"
API="https://addons.mozilla.org/api/v5/addons"
VERSIONS_URL="https://addons.mozilla.org/developers/addon/read-aloud-fork-le/versions"
WEB_EXT="web-ext@10.8.0"
XPI="$(cd .. && pwd)/spotlight-reader.zip"
SRC="$(cd .. && pwd)/spotlight-reader-source.zip"

die() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARNING: $*" >&2; }
usage() { sed -n '2,5p' "$SELF" >&2; exit 2; }
# Precondition failed: abort for a real submission, only warn in a dry run.
precondition() { if [ "$DRY_RUN" = 1 ]; then warn "$*"; else die "$*"; fi; }

# Reads only JWT_ISSUER / JWT_KEY from amo.env (no `source`) into unexported
# variables; with_keys hands them only to the commands that need them, under
# the names web-ext reads from the environment (keeps them out of argv).
load_keys() {
  [ -f amo.env ] || die "amo.env missing (needs JWT_ISSUER and JWT_KEY)"
  local issuer key
  issuer=$(sed -n 's/^JWT_ISSUER=//p' amo.env | tail -n 1)
  key=$(sed -n 's/^JWT_KEY=//p' amo.env | tail -n 1)
  [ -n "$issuer" ] || die "JWT_ISSUER missing or empty in amo.env"
  [ -n "$key" ] || die "JWT_KEY missing or empty in amo.env"
  API_KEY="$issuer"
  API_SECRET="$key"
}

with_keys() { WEB_EXT_API_KEY="$API_KEY" WEB_EXT_API_SECRET="$API_SECRET" "$@"; }

check_clean() {
  local status dirty
  status=$(git status --porcelain)
  dirty=$(printf '%s\n' "$status" | grep -vE '^.. \.claude/' || true)
  [ -z "$dirty" ] || precondition "working tree not clean (zips would contain uncommitted changes):
$dirty"
}

check_version() {
  local pkg
  pkg=$(node -p "require('./package.json').version")
  [ "$VERSION" = "$pkg" ] || precondition "version mismatch: manifest.json $VERSION, package.json $pkg"
}

# Reviewer notes = tools/LISTING.md §2 from "**Build instructions**" up to the
# closing "---" (without heading, human-only hint lines and separator).
approval_notes() {
  awk '/^## 2\./ { s = 1; next }
       s && /^---$/ { exit }
       s && /^\*\*Build instructions\*\*/ { p = 1 }
       p { buf = buf $0 "\n" }
       END { sub(/\n+$/, "", buf); if (buf != "") print buf }' tools/LISTING.md
}

# Writes the metadata JSON for web-ext --amo-metadata; values via argv/file,
# never interpolated into code.
write_metadata() { # <release notes> <approval notes file> <out file>
  node -e '
    const fs = require("fs");
    const [notes, approvalFile, out] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({ version: {
      release_notes: { "en-US": notes },
      approval_notes: fs.readFileSync(approvalFile, "utf8"),
      compatibility: ["firefox", "android"],
    } }, null, 2));
  ' -- "$1" "$2" "$3"
}

# Fresh, short-lived JWT (HS256, 60 s) as a curl header file; never in argv or output.
auth_header() {
  with_keys node -e '
    const crypto = require("crypto");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const data = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({
      iss: process.env.WEB_EXT_API_KEY, jti: crypto.randomUUID(), iat: now, exp: now + 60 });
    const sig = crypto.createHmac("sha256", process.env.WEB_EXT_API_SECRET).update(data).digest("base64url");
    process.stdout.write("Authorization: JWT " + data + "." + sig + "\n");
  ' > "$TMP/auth.hdr"
}

# api <curl args...> → prints the HTTP status, body in $TMP/body.
api() {
  auth_header
  curl -sS --max-time 300 -H @"$TMP/auth.hdr" -o "$TMP/body" -w '%{http_code}' "$@"
}

# json <expression on `d`> → evaluates against the last response body.
json() {
  node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
           const v = eval(process.argv[1]); console.log(typeof v === "object" ? JSON.stringify(v) : v);' \
    "$1" "$TMP/body"
}

# web-ext sign re-packs --source-dir and silently drops these (lib/util/file-filter.js);
# the real upload must equal the build.sh zip that the dry run validates.
check_package() {
  local files
  files=$(unzip -Z1 "$XPI")
  if printf '%s\n' "$files" | grep -E '(^|/)\.|\.(zip|xpi)$|(^|/)node_modules/' >&2; then
    die "package contains files web-ext would drop (dotfiles, *.zip/*.xpi, node_modules), see above"
  fi
}

body_excerpt() { head -c 500 "$TMP/body"; echo; }

check_version_free() {
  local code
  code=$(api "$API/addon/$ADDON_ID/versions/v$VERSION/")
  case "$code" in
    404) echo "AMO: version $VERSION not taken yet." ;;
    200) precondition "version $VERSION already exists on AMO. If it came from an earlier partial upload, check $VERSIONS_URL and add source/notes in the web UI." ;;
    401|403) die "AMO rejected the API keys (HTTP $code) - check amo.env" ;;
    *) die "version check: unexpected HTTP $code: $(body_excerpt)" ;;
  esac
}

# Upload for validation only; without the follow-up PUT no version is created.
dry_run_validate() {
  local code uuid i processed
  echo "Uploading $XPI for AMO validation (no version is created)..."
  code=$(api -F "upload=@$XPI" -F "channel=listed" "$API/upload/")
  [ "$code" = 200 ] || [ "$code" = 201 ] || die "upload: HTTP $code: $(body_excerpt)"
  uuid=$(json 'd.uuid')
  [[ "$uuid" =~ ^[0-9a-f-]+$ ]] || die "upload: no uuid in response: $(body_excerpt)"
  for i in $(seq 150); do
    code=$(api "$API/upload/$uuid/")
    [ "$code" = 200 ] || die "validation status: HTTP $code: $(body_excerpt)"
    processed=$(json 'd.processed')
    [ "$processed" = true ] && break
    [ "$i" -lt 150 ] || die "validation not finished after 5 minutes (upload $uuid)"
    sleep 2
  done
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = d.validation || {};
    console.log(`AMO validation: valid=${d.valid} errors=${v.errors} warnings=${v.warnings} notices=${v.notices}`);
    for (const m of v.messages || []) if (m.type === "error") console.log(`  error: ${m.message}`);
    process.exit(d.valid ? 0 : 1);
  ' "$TMP/body" || die "AMO validation failed"
}

submit() {
  unzip -q "$XPI" -d "$TMP/src"
  approval_notes > "$TMP/approval.txt"
  [ -s "$TMP/approval.txt" ] || die "reviewer notes not found in tools/LISTING.md §2"
  write_metadata "$NOTES" "$TMP/approval.txt" "$TMP/meta.json"
  echo "Submitting version $VERSION to AMO (listed)..."
  with_keys npx --yes "$WEB_EXT" sign --channel listed --source-dir "$TMP/src" \
    --artifacts-dir "$TMP/artifacts" --amo-metadata "$TMP/meta.json" \
    --upload-source-code "$SRC" --approval-timeout 0 \
    || die "web-ext sign failed. A version may exist without source/notes: check $VERSIONS_URL and complete it in the web UI (tools/release.md, manual fallback)."
  echo "Submitted: version $VERSION is in AMO review ($VERSIONS_URL). Tag only after approval."
}

# --- main ---
DRY_RUN=0
NOTES=""
case "${1:-}" in
  --dry-run) [ $# -eq 1 ] || usage; DRY_RUN=1 ;;
  -[!\ ]*) usage ;;  # options; notes may start with "- " (bullet list)
  *) [ $# -eq 1 ] && [ -n "${1//[[:space:]]/}" ] || usage; NOTES="$1" ;;
esac

load_keys
VERSION=$(node -p "require('./manifest.json').version")
check_clean
check_version

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

bash tools/build.sh
bash tools/source-package.sh
check_package
check_version_free

if [ "$DRY_RUN" = 1 ]; then
  dry_run_validate
else
  submit
fi
