# AMO listing — Spotlight Reader

Everything needed to submit the **listed** (publicly searchable) version on
addons.mozilla.org. Copy the metadata blocks into the AMO listing form; the
reviewer section covers the source-code requirement.

---

## 1. Public listing metadata

**Name**
```
Spotlight Reader
```

**Summary** (≤ 250 characters)
```
Read any web page aloud with natural offline voices and live sentence-level highlighting. Free and private — no account needed. Offline Supertonic TTS plus Google Translate and optional cloud voices (Google, Amazon, Azure, OpenAI, IBM).
```

**Description**
```
Spotlight Reader reads the article on the current web page aloud and highlights
each sentence as it is spoken — directly on the page, Speechify-style. Click any
sentence to jump to it.

★ Offline & private
- Supertonic neural TTS runs fully on your device (31 languages incl. German,
  English, Spanish, French, Korean, Portuguese). Install once, then no internet
  and no account required.
- No telemetry, no unsolicited network requests.

★ Many voices
- Free online: Google Translate.
- Offline: Supertonic and Piper.
- Optional cloud voices with your own API key: Google WaveNet/Neural2/Chirp3-HD,
  Amazon Polly, Microsoft Azure, OpenAI (and OpenAI-compatible), IBM Watson.

★ Reading experience
- Sentence-level in-page highlighting with hover preview and click-to-seek.
- Voice favorites, per-language auto-select, adjustable speed.
- Redesigned settings with light/dark mode.

Spotlight Reader is an independent fork of the open-source "Read Aloud" by
ken107 (MIT-licensed), focused on offline TTS and in-page highlighting for
Firefox. Source code: https://github.com/luc42ei/spotlight-reader

If you find Spotlight Reader useful, consider supporting development:
https://ko-fi.com/lucaseichhorn
```

**Category:** Other (secondary: Language Support & Translation)

**Tags / keywords:** text to speech, TTS, read aloud, highlighting, accessibility, offline voices

**URLs**
- Homepage / Support: `https://github.com/luc42ei/spotlight-reader`
- Bug reports: `https://github.com/luc42ei/spotlight-reader/issues`
- Contribute (donations): `https://ko-fi.com/lucaseichhorn`

**Data collection:** None required; one optional type. (`manifest.json`:
`data_collection_permissions.required: ["none"]`, `optional: ["websiteContent"]`.)
The optional `websiteContent` covers PDFs only: they are rendered by the PDF
viewer hosted on assets.lsdsoftware.com (from the original Read Aloud), which
receives the PDF. Firefox asks for it the first time the user reads a PDF.
If AMO asks for a privacy statement: "Spotlight Reader does not collect or
store any personal data. Text is sent to a TTS provider only for the voice you
select (e.g. Google Translate or a cloud voice you configured); offline voices
send nothing. PDFs are only opened in the hosted viewer after you allow it."

**License:** MIT (retains the original copyright; see `LICENSE`).

---

## 2. Notes for the reviewer

Paste into the "Notes to reviewer" field, and upload the source package
(`tools/source-package.sh` → `../spotlight-reader-source.zip`).

**Build instructions**
- No compiler/bundler. The extension ships its source as-is.
- To reproduce the submitted package: unzip the source, then run
  `bash tools/build.sh` (requires only `zip`). It produces an identical
  extension archive (it excludes `tools/`, `docs/`, `README.md`,
  `package.json`, `updates.json`).
- `js/aws-sdk.js` is **not** the official AWS SDK — it is a small,
  hand-written, unminified AWS SigV4 request signer (readable source).

**Third-party prebuilt / minified assets (unmodified upstream builds):**

| File(s) | Library | Version | Source |
|---|---|---|---|
| `js/jquery-3.7.1.min.js` | jQuery | 3.7.1 | https://code.jquery.com/jquery-3.7.1.min.js |
| `js/rxjs.umd.min.js` | RxJS (UMD bundle) | 7.x | https://unpkg.com/rxjs/dist/bundles/rxjs.umd.min.js |
| `js/peerjs.min.js` | PeerJS | 1.5.2 | https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js |
| `lib/onnxruntime/ort.wasm.min.js`, `lib/onnxruntime/ort-wasm-simd-threaded.mjs`, `lib/onnxruntime/ort-wasm-simd-threaded.wasm` | ONNX Runtime Web | 1.30.0 | https://www.npmjs.com/package/onnxruntime-web/v/1.30.0 (files from `dist/`) |

**Runtime-downloaded models (NOT in the package):**
- **Supertonic** voice models — downloaded only when the user clicks "Install
  Supertonic voices…", from https://huggingface.co/Supertone/supertonic-3, then
  cached locally (Cache API + IndexedDB). ~250 MB.
- **Piper** voice models — downloaded per voice on user action.

**Permissions rationale**
- `activeTab` / `scripting` — inject the reader/highlight into the page the user
  activates.
- `contextMenus` — "Read aloud selected text" and "Read aloud from here" entries.
- `menus` — lets "Read aloud from here" find the right-clicked element (`menus.getTargetElement`); nothing else.
- `storage` — save settings, favorites, cached voice lists, and the last reading position per page (sentence + URL, local only, max. 100 pages) so reading can resume.
- `unlimitedStorage` — keep the downloaded offline voice models (Supertonic
  ~250 MB, Piper) from being evicted, so they aren't re-downloaded.
- `host_permissions: translate.google.com` — the free Google Translate voice.
- Optional `webRequest`/`webNavigation` and broad host permissions are requested
  only when needed for specific sites/features.

**Remaining requests to the original author's server** (`support.readaloud.app`,
no page content, no identifiers): the Google voice name list
(`/read-aloud/list-voices/google`, daily) and the sample sentence for "Test
voice" in the options (`/read-aloud/get-demo-speech-text/<lang>`). The premium
voices, sign-in and the MathML-to-speech upload of the original were removed in
3.2.5; math is now read from `alttext`/`aria-label` or the MathML tokens locally.

**WASM note:** `content_security_policy` allows `wasm-unsafe-eval` solely to run
the ONNX Runtime that powers offline Supertonic TTS — no remote code is loaded
or evaluated.

---

## 3. Before submitting the listed build

- For the **listed** build, remove `browser_specific_settings.gecko.update_url`
  from `manifest.json` — AMO manages updates for listed add-ons, and a
  self-hosted `update_url` is not allowed there. (The self-hosted/unlisted
  GitHub release flow keeps using it; keep them as separate builds.)
- AMO version numbers are unique per add-on: a version already uploaded as
  unlisted cannot be reused for the listed submission — bump for the listed one.
- Keep the gecko id `read-aloud-fork@lucaseichhorn` unchanged (preserves the
  add-on identity).
