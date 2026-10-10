#!/usr/bin/env node
// Replays the player's speak/prefetch pattern against the real `cache` from
// js/tts-engines.js and the real text breakers from js/speech.js, and counts
// what the TTS backend sees. See README.md.
const fs = require("fs")
const path = require("path")
const vm = require("vm")
const {execSync} = require("child_process")

const ROOT = path.resolve(__dirname, "../..")
const args = parseArgs(process.argv.slice(2))
if (!args._.length) {
  console.error("usage: prefetch_sim.js [--engines FILE] [--real] [--voice NAME] [--rate R] [--seconds S] [--project ID] [--json] text.txt...")
  process.exit(1)
}

function parseArgs(argv) {
  const out = {_: []}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a == "--real" || a == "--json") out[a.slice(2)] = true
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i]
    else out._.push(a)
  }
  return out
}

// --- lift cache + chunker from the sources
function liftCache(src) {
  const start = src.indexOf("const cache = {")
  const body = src.slice(start, src.indexOf("\n}\n", start) + 2).replace(/^const cache = /, "")
  return () => vm.runInContext("(" + body + ")", vm.createContext({}))
}
const makeCache = liftCache(fs.readFileSync(args.engines || path.join(ROOT, "js/tts-engines.js"), "utf8"))

const speechSrc = fs.readFileSync(path.join(ROOT, "js/speech.js"), "utf8")
const breakers = speechSrc.slice(speechSrc.indexOf("  //text breakers"), speechSrc.lastIndexOf("}"))
const chunkCtx = vm.createContext({console})
vm.runInContext(fs.readFileSync(path.join(ROOT, "js/sentence-splitter.js"), "utf8") + "\nthis.raSentenceSplitter = raSentenceSplitter", chunkCtx)
vm.runInContext(breakers + `
  this.chunk = function(texts) {
    var punctuator = new LatinPunctuator(), out = []
    texts.forEach(t => { if (/[\\w)]$/.test(t)) t += "."
      new CharBreaker(200, punctuator).breakText(t).forEach(c => { if (/[\\p{L}\\p{N}]/u.test(c)) out.push(c) }) })
    return out
  }`, chunkCtx)

// --- clocks
function virtualClock() {
  let now = 0, seq = 0
  const q = []
  return {
    now: () => now,
    sleep: ms => new Promise(r => q.push({t: now + ms, seq: seq++, fn: r})),
    async run(isDone) {
      while (!isDone()) {
        await new Promise(r => setImmediate(r))
        if (!q.length) continue
        q.sort((a, b) => a.t - b.t || a.seq - b.seq)
        const e = q.shift(); now = e.t; e.fn()
      }
    },
  }
}
function realClock() {
  const t0 = Date.now()
  return {
    now: () => Date.now() - t0,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    async run(isDone) { while (!isDone()) await new Promise(r => setTimeout(r, 50)) },
  }
}

// --- backends: resolve to {durationMs}
function fakeBackend(clock, latency, charsPerSec) {
  return text => clock.sleep(latency(text.length)).then(() => ({durationMs: text.length / charsPerSec * 1000}))
}
function googleBackend(voice, rate) {
  const token = execSync("gcloud auth print-access-token", {encoding: "utf8"}).trim()
  const project = args.project || execSync("gcloud config get-value project", {encoding: "utf8"}).trim()
  const languageCode = voice.split("-").slice(0, 2).join("-")
  return async text => {
    const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: {"Authorization": "Bearer " + token, "x-goog-user-project": project, "Content-Type": "application/json"},
      body: JSON.stringify({
        input: {text},
        voice: {languageCode, name: voice},
        audioConfig: {audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate: rate},
      }),
    })
    if (!res.ok) throw new Error("HTTP " + res.status + " " + await res.text())
    const {audioContent} = await res.json()
    // LINEAR16 = 16-bit mono PCM behind a 44-byte WAV header
    return {durationMs: (Buffer.from(audioContent, "base64").length - 44) / 2 / 24000 * 1000}
  }
}

// --- the player loop (mirrors js/speech.js: makePlayback → engine.speak(i),
// then the "load" event prefetches i+1 and i+2)
async function play(chunks, clock, synth, maxMs) {
  const cache = makeCache()
  const k = {chunks: 0, requests: 0, billedChars: 0, spokenChars: 0, created: 0, revoked: 0, waitMs: 0, stalls: 0, errors: 0, firstAudioMs: null}
  const get = text => cache.fetchCached(text, () => {
    k.requests++; k.billedChars += text.length
    return synth(text).then(v => { k.created++; return v })
  }, () => k.revoked++)

  let done = false
  ;(async () => {
    for (let i = 0; i < chunks.length && clock.now() < maxMs; i++) {
      const t0 = clock.now()
      const p = get(chunks[i])
      for (let j = 1; j <= 2; j++)
        if (chunks[i + j]) get(chunks[i + j]).catch(() => k.errors++)
      let audio
      try { audio = await p } catch (err) { k.errors++; console.error(err.message); continue }
      const wait = clock.now() - t0
      if (i == 0) k.firstAudioMs = wait
      else { k.waitMs += wait; if (wait > 100) k.stalls++ }
      k.chunks++; k.spokenChars += chunks[i].length
      await clock.sleep(audio.durationMs)
    }
    done = true
  })().catch(err => { console.error(err); done = true })
  await clock.run(() => done)
  // let in-flight prefetches land so their blob URLs count
  await new Promise(r => setTimeout(r, args.real ? 5000 : 0))
  k.leaked = k.created - k.revoked - cache.entries.size
  return k
}

function report(k) {
  return {
    chunks: k.chunks,
    requests: k.requests,
    extraChars: (100 * (k.billedChars - k.spokenChars) / k.spokenChars).toFixed(1) + "%",
    firstAudio: (k.firstAudioMs / 1000).toFixed(2) + "s",
    stalls: k.stalls,
    waitSec: (k.waitMs / 1000).toFixed(1),
    leakedBlobs: k.leaked,
    errors: k.errors,
  }
}

;(async () => {
  const rows = []
  for (const file of args._) {
    const texts = fs.readFileSync(file, "utf8").split(/\n+/).map(s => s.trim()).filter(Boolean)
    const chunks = chunkCtx.chunk(texts)
    const name = path.basename(file, ".txt")
    if (args.real) {
      const rate = Number(args.rate || 1)
      const clock = realClock()
      const k = await play(chunks, clock, googleBackend(args.voice || "de-DE-Chirp3-HD-Charon", rate), Number(args.seconds || 600) * 1000)
      rows.push({text: name, backend: "google", rate, ...report(k)})
    }
    else {
      const latencies = {fast: n => 300 + 2 * n, typical: n => 600 + 6 * n, slow: n => 1000 + 12 * n}
      for (const [lat, fn] of Object.entries(latencies)) for (const rate of [1, 1.5]) {
        const clock = virtualClock()
        const k = await play(chunks, clock, fakeBackend(clock, fn, 14 * rate), Infinity)
        rows.push({text: name, latency: lat, rate, ...report(k)})
      }
    }
  }
  if (args.json) console.log(JSON.stringify(rows, null, 1))
  else console.table(rows)
})()
