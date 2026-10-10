# prefetch_sim — what the TTS backend sees during playback

Replays a whole article through the player's speak/prefetch pattern and counts
the synthesis requests, billed characters and playback stalls. Use it before
touching chunk size, prefetch depth or the audio cache.

## How it works

- **Text breakers** are lifted out of `js/speech.js` at runtime
  (CharBreaker(200), the cloud path), so chunk boundaries match real playback.
- **The cache** (`const cache = {…}`) is lifted out of `js/tts-engines.js`, or out of
  `--engines FILE`, which you use for A/B against a baseline.
- **The player loop is re-implemented** and mirrors `js/speech.js`: `makePlayback`
  calls `engine.speak(i)`, then the `"load"` event prefetches `i+1` and `i+2`,
  and the next chunk starts when the audio ends. If that order changes in
  `speech.js`, update `play()` here.

There are two backends:

- **Default, simulated.** Runs on a virtual clock, so a whole article takes
  under a second. It sweeps three latency models (`fast` 0.3 s + 2 ms/char,
  `typical` 0.6 s + 6 ms/char, `slow` 1 s + 12 ms/char) at rate 1 and 1.5, with
  speech at 14 chars/s × rate.
- **`--real`.** Calls the Google Cloud TTS API with `gcloud auth
  print-access-token` against the project from `--project` (default: the gcloud
  config project, which must have the Text-to-Speech API enabled). It runs in real time, takes real network latency, and
  gets the real audio duration from LINEAR16 output. **It costs money**: Chirp 3
  HD bills per input character.

## Usage

```sh
tools/prefetch-sim/fetch_texts.sh            # sample articles → texts/ (gitignored)
node tools/prefetch-sim/prefetch_sim.js tools/prefetch-sim/texts/*.txt

# A/B against the committed cache
git show HEAD:js/tts-engines.js > /tmp/tts-engines.base.js
node tools/prefetch-sim/prefetch_sim.js --engines /tmp/tts-engines.base.js tools/prefetch-sim/texts/de-BVerfG.txt

# real API, 10 minutes of playback at rate 1.5
node tools/prefetch-sim/prefetch_sim.js --real --voice de-DE-Chirp3-HD-Charon --rate 1.5 --seconds 600 --project MY-PROJECT tools/prefetch-sim/texts/de-30jKrieg.txt
```

## Columns

| Column | Meaning |
|---|---|
| `requests` | synthesis calls that reached the backend |
| `extraChars` | billed characters beyond those actually spoken (duplicate requests, plus prefetches past the stop point in `--real`) |
| `firstAudio` | wait before chunk 0, which is unavoidable |
| `stalls` / `waitSec` | chunks after the first one that waited more than 100 ms for audio, and the total wait |
| `leakedBlobs` | audio URLs that were created but never handed to `destroyFn` (`URL.revokeObjectURL`) |

Use the API-free mode for wide sweeps and `--real` only to confirm a result.
In `--real`, run baseline and fix back to back with the same text, rate and
duration, because network latency drifts.
