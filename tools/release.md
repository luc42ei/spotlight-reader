# Release checklist

1. Make changes, commit
2. Bump version in `manifest.json` and `updates.json` (must match)
3. `bash tools/build.sh` → produces `../read-aloud-fork.zip`
4. Submit zip to https://addons.mozilla.org/de/developers/addon/read-aloud-fork-le/versions/submit/
5. Download the signed `.xpi` from the AMO developer page → lands in `~/Downloads/read_aloud_fork_le-<version>.xpi`
6. Create GitHub Release tagged `v<version>` and upload the signed XPI **renamed** to `read-aloud-fork.xpi`:

   ```bash
   V=2.22.7
   cp ~/Downloads/read_aloud_fork_le-$V.xpi /tmp/read-aloud-fork.xpi
   gh release create v$V /tmp/read-aloud-fork.xpi --title "v$V" --notes "..."
   rm /tmp/read-aloud-fork.xpi
   ```

7. Verify the auto-update chain end-to-end (see below) — **do this before pushing** so a broken release can still be fixed without users seeing it
8. `git push origin master` so existing users auto-update
9. Delete the old signed `.xpi` files from `~/Downloads` — keep only the current version:

   ```bash
   find ~/Downloads -name 'read_aloud_fork_le-*.xpi' ! -name "read_aloud_fork_le-$V.xpi" -delete
   ```

## Verification (after step 6, before step 8)

```bash
V=2.22.7
echo '== updates.json (what Firefox fetches) =='
curl -s https://raw.githubusercontent.com/luc42ei/read-aloud/master/updates.json
echo '== XPI download =='
curl -s -L -o /tmp/check.xpi -w "status=%{http_code} size=%{size_download}\n" \
  https://github.com/luc42ei/read-aloud/releases/download/v$V/read-aloud-fork.xpi
unzip -p /tmp/check.xpi manifest.json | grep '"version"'
rm /tmp/check.xpi
```

All three must agree on `<version>`. Status must be `200` and size > 1 MB.

## Pitfalls

- **Asset filename must be exactly `read-aloud-fork.xpi`** — `updates.json` hard-codes that path. `gh release create file#label` only sets the *label*, **not** the filename. Always rename the file on disk first (see step 6 snippet). If the asset ends up wrong: `gh release delete-asset v<version> <wrong-name> --yes && gh release upload v<version> /tmp/read-aloud-fork.xpi`.
- **`curl -I` (HEAD) on the release download returns 404** even when the file is fine — GitHub serves release assets through a signed Azure redirect that handles HEAD differently. Always verify with `curl -L` (GET + follow). Firefox uses GET, so this is cosmetic only.
- **Don't push before the release exists.** `updates.json` points at the GitHub release URL; if pushed first, Firefox will see the new version but fail to download.

## Versioning

Follows semantic versioning loosely — upstream was forked at `2.22.x`:

| Change type | Which number | Example |
|---|---|---|
| Bug fix, performance, small tweak | patch (`2.22.x`) | `2.22.10` → `2.22.11` |
| New user-visible feature | minor (`2.y.0`) | `2.22.x` → `2.23.0` |
| Breaking change in storage/API | major (`x.0.0`) | rarely needed |

Firefox only uses the version as an ordinal (higher = newer), so the scheme
is for human orientation, not machine semantics.

## Notes

- AMO is unlisted — signed but not publicly searchable
- `updates.json` is fetched by Firefox to detect new versions; the `update_link` must point to the signed XPI on GitHub Releases
- `update_url` in `manifest.json` points to the raw GitHub URL of `updates.json`:
  `https://raw.githubusercontent.com/luc42ei/read-aloud/master/updates.json`
- Do not include `updates.json` in the zip (already excluded in `build.sh`)
- Manual update check: Firefox `about:addons` → gear icon → "Check for Updates"
