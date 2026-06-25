# Release checklist (AMO listed)

Spotlight Reader is a **listed** add-on: addons.mozilla.org hosts it, signs each
version, and delivers auto-updates. There is **no** self-hosted XPI / GitHub
release / `updates.json` step anymore (that was the old unlisted flow — see
"Legacy" at the bottom).

## Steps

1. Make changes, commit.
2. Bump version in `manifest.json` and `package.json` (must match). AMO version
   numbers are unique per add-on — pick a higher one each time. (A version
   rejected at validation was never created, so its number can be reused; an
   accepted/in-review version's number cannot.)
3. `bash tools/build.sh` → `../spotlight-reader.zip`
4. `bash tools/source-package.sh` → `../spotlight-reader-source.zip`
5. AMO → the add-on (`read-aloud-fork-le`) → **Upload New Version** → channel
   **On this site (listed)** → upload `../spotlight-reader.zip`.
6. When asked *"Do you use minified, concatenated or machine-generated code?"* →
   **Yes** → upload `../spotlight-reader-source.zip`.
7. Fill the two text fields on the "Version beschreiben" page:
   - **Versionshinweise** (public changelog) — see template below.
   - **Anmerkungen für Kontrolleure** — paste the reviewer-notes block from
     `tools/LISTING.md` §2 (build steps + third-party provenance). Required every
     version because of the bundled minified libs + ONNX WASM.
8. Submit → wait for human review. On approval AMO signs and publishes; existing
   users auto-update from AMO.
9. Tag git for history and push: `git tag v<version> && git push origin master --tags`.

## Version notes template (public — "Versionshinweise")

Short and user-facing. Examples:

```
New app and toolbar icon; popup accent color refreshed.
```
```
Fix in-page highlighting on legacy pages; faster Supertonic startup.
```

## Pitfalls

- **Icons must be square.** AMO rejects non-square icons. Every declared icon
  (`img/icon.png` and `img/icon_spot.png`) must be N×N. Quick check:
  ```bash
  python3 -c "from PIL import Image; [print(f, Image.open(f).size) for f in ['img/icon.png','img/icon_spot.png']]"
  ```
- **Source code is required every version** — the package bundles minified
  jQuery / RxJS / PeerJS and the ONNX Runtime WASM. Always upload
  `../spotlight-reader-source.zip` and the reviewer notes (LISTING.md §2).
- Keep the gecko id `read-aloud-fork@lucaseichhorn` unchanged — it is the add-on
  identity.
- `tools/` (incl. `LISTING.md`, build scripts), `docs/`, `*.xcf` and screenshots
  are excluded from the extension package by `build.sh` — keep it that way.

## Versioning

Loose semver (forked from upstream `2.22.x`; now on `3.x`):

| Change type | Which number | Example |
|---|---|---|
| Bug fix, performance, small tweak | patch | `3.0.2` → `3.0.3` |
| New user-visible feature | minor | `3.0.x` → `3.1.0` |
| Breaking change in storage/API | major | `3.x` → `4.0.0` |

Firefox/AMO only use the version as an ordinal (higher = newer).

## Legacy (retired unlisted self-hosting)

Before listing, releases were self-hosted: a Mozilla-signed `.xpi` on GitHub
Releases, discovered via `updates.json` + `gecko.update_url`. Retired when the
add-on went listed (`update_url` removed from the manifest).

- `updates.json` stays pinned at **3.0.0** for any remaining self-hosted installs
  but is no longer updated; the `v3.0.0` GitHub release is the last self-hosted
  build.
- Do not re-add `update_url` to the listed build — AMO disallows it for listed
  add-ons.
