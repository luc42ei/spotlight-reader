
// Worker base URL varies by browser — use self.location to build absolute paths
const workerDir = self.location.href.replace(/[^/]+$/, "")
const extRoot = workerDir.replace(/js\/$/, "")

importScripts(workerDir + "supertonic-idb.js")
importScripts(extRoot + "lib/onnxruntime/ort.wasm.min.js")

const HF_BASE = "https://huggingface.co/Supertone/supertonic-3/resolve/main"

let tts = null
let voiceStyleCache = {}

// Multi-thread WASM needs SharedArrayBuffer (cross-origin isolation is set in manifest).
// Use up to 4 threads — more often regresses due to inference overhead vs cores.
ort.env.wasm.numThreads = (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated)
  ? Math.max(1, Math.min(4, (self.navigator && self.navigator.hardwareConcurrency || 2) - 1))
  : 1
ort.env.wasm.simd = true
ort.env.wasm.wasmPaths = extRoot + "lib/onnxruntime/"

// Serialize synthesis: when several speak/loadModels arrive while one is running,
// async/await in onmessage would let them interleave on a single WASM thread,
// inflating each one's wall-clock time and delaying the first result. A FIFO queue
// keeps the first chunk ready ASAP so playback can start while the rest pipeline.
let workQueue = Promise.resolve()

onmessage = function(e) {
  if (e.data.method === "isReady") {
    postMessage({id: e.data.id, result: tts != null})
    return
  }
  workQueue = workQueue.then(() => handle(e), () => handle(e))
}

async function handle(e) {
  try {
    switch (e.data.method) {
      case "loadModels":
        await loadModels(e.data)
        postMessage({id: e.data.id, result: "ok"})
        break
      case "cacheModels":
        await cacheModels(e.data)
        postMessage({id: e.data.id, result: "ok"})
        break
      case "speak":
        const wav = await speak(e.data)
        postMessage({id: e.data.id, result: wav}, [wav])
        break
    }
  } catch (err) {
    postMessage({id: e.data.id, error: err.message || String(err)})
  }
}

const MODEL_CACHE = "supertonic-models-v2"

async function cacheModels() {
  const allFiles = [
    "onnx/tts.json",
    "onnx/unicode_indexer.json",
    "onnx/duration_predictor.onnx",
    "onnx/text_encoder.onnx",
    "onnx/vector_estimator.onnx",
    "onnx/vocoder.onnx"
  ]
  const cache = await caches.open(MODEL_CACHE)
  for (let i = 0; i < allFiles.length; i++) {
    const name = allFiles[i]
    postMessage({type: "progress", step: i + 1, total: allFiles.length, name})
    if (name.endsWith(".json")) {
      await fetchJson(name)
    } else {
      const url = `${HF_BASE}/${name}`
      if (!await cache.match(url)) {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`)
        await cache.put(url, resp)  // streams to disk — no memory buffering
      }
    }
  }
}

async function loadModels(opts) {
  if (tts) return

  const sessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  }

  const cfgs = await fetchJson("onnx/tts.json")
  const indexer = await fetchJson("onnx/unicode_indexer.json")
  const textProcessor = new UnicodeProcessor(indexer)

  const modelNames = [
    "onnx/duration_predictor.onnx",
    "onnx/text_encoder.onnx",
    "onnx/vector_estimator.onnx",
    "onnx/vocoder.onnx"
  ]

  const sessions = []
  for (let i = 0; i < modelNames.length; i++) {
    postMessage({type: "progress", step: i + 1, total: modelNames.length + 1, name: modelNames[i]})
    const buf = await fetchBinary(modelNames[i])
    const session = await ort.InferenceSession.create(buf, sessionOptions)
    sessions.push(session)
  }

  postMessage({type: "progress", step: modelNames.length + 1, total: modelNames.length + 1, name: "ready"})

  tts = new TextToSpeech(cfgs, textProcessor, ...sessions)
}

async function speak({text, lang, voiceName, speed}) {
  if (!tts) throw new Error("Models not loaded")

  lang = lang || "en"
  speed = speed || 1.05

  const style = await getVoiceStyle(voiceName)
  const {wav} = await tts.call(text, lang, style, 6, speed)
  return writeWavFile(wav, tts.sampleRate)
}

async function fetchJson(name) {
  let data = await supertonicIdb.getCachedModel(name)
  if (data) return data
  const resp = await fetch(`${HF_BASE}/${name}`)
  if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`)
  data = await resp.json()
  await supertonicIdb.putCachedModel(name, data)
  return data
}

async function fetchBinary(name) {
  const url = `${HF_BASE}/${name}`
  const cache = await caches.open(MODEL_CACHE)
  const cached = await cache.match(url)
  if (cached) return cached.arrayBuffer()
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`)
  await cache.put(url, resp.clone())
  return resp.arrayBuffer()
}

async function getVoiceStyle(voiceName) {
  if (voiceStyleCache[voiceName]) return voiceStyleCache[voiceName]

  const styleKey = `voice_styles/${voiceName}.json`
  let styleJson = await supertonicIdb.getCachedVoice(voiceName)
  if (!styleJson) {
    const resp = await fetch(`${HF_BASE}/${styleKey}`)
    if (!resp.ok) throw new Error(`Failed to fetch voice style ${voiceName}: ${resp.status}`)
    styleJson = await resp.json()
    await supertonicIdb.putCachedVoice(voiceName, styleJson)
  }

  const ttlFlat = new Float32Array(styleJson.style_ttl.data.flat(Infinity))
  const dpFlat = new Float32Array(styleJson.style_dp.data.flat(Infinity))
  const style = new Style(
    new ort.Tensor("float32", ttlFlat, styleJson.style_ttl.dims),
    new ort.Tensor("float32", dpFlat, styleJson.style_dp.dims)
  )
  voiceStyleCache[voiceName] = style
  return style
}


// --- Adapted from supertonic helper.js ---

const AVAILABLE_LANGS = ["en", "ko", "es", "pt", "fr", "de", "ja", "ar", "bg", "cs", "da", "el", "et", "fi", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi"]

class Style {
  constructor(ttl, dp) {
    this.ttl = ttl
    this.dp = dp
  }
}

class UnicodeProcessor {
  constructor(indexer) {
    this.indexer = indexer
  }

  call(textList, langList) {
    const processed = textList.map((t, i) => this.preprocess(t, langList[i]))
    const lengths = processed.map(t => t.length)
    const maxLen = Math.max(...lengths)

    const textIds = processed.map(text => {
      const row = new Array(maxLen).fill(0)
      for (let j = 0; j < text.length; j++) {
        const cp = text.codePointAt(j)
        row[j] = cp < this.indexer.length ? this.indexer[cp] : -1
      }
      return row
    })

    return {textIds, textMask: this.lengthToMask(lengths, maxLen)}
  }

  preprocess(text, lang) {
    text = text.normalize("NFKD")
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, "")

    const replacements = {
      "\u2013": "-", "\u2011": "-", "\u2014": "-", "_": " ",
      "\u201C": '"', "\u201D": '"', "\u2018": "'", "\u2019": "'",
      "\u00B4": "'", "`": "'", "[": " ", "]": " ", "|": " ",
      "/": " ", "#": " ", "\u2192": " ", "\u2190": " "
    }
    for (const [k, v] of Object.entries(replacements)) text = text.replaceAll(k, v)
    text = text.replace(/[♥☆♡©\\]/g, "")
    text = text.replaceAll("@", " at ").replaceAll("e.g.,", "for example, ").replaceAll("i.e.,", "that is, ")
    text = text.replace(/ -+ /g, ", ")  // dash between phrases → comma, better duration prediction
    text = text.replace(/ ([,\.!\?;:])/g, "$1")
    while (text.includes('""')) text = text.replace('""', '"')
    while (text.includes("''")) text = text.replace("''", "'")
    text = text.replace(/\s+/g, " ").trim()
    if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += "."

    if (!AVAILABLE_LANGS.includes(lang)) lang = "en"
    return `<${lang}>${text}</${lang}>`
  }

  lengthToMask(lengths, maxLen) {
    return lengths.map(len => {
      const row = new Array(maxLen).fill(0.0)
      for (let j = 0; j < Math.min(len, maxLen); j++) row[j] = 1.0
      return [row]
    })
  }
}

class TextToSpeech {
  constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
    this.cfgs = cfgs
    this.textProcessor = textProcessor
    this.dpOrt = dpOrt
    this.textEncOrt = textEncOrt
    this.vectorEstOrt = vectorEstOrt
    this.vocoderOrt = vocoderOrt
    this.sampleRate = cfgs.ae.sample_rate
  }

  async call(text, lang, style, totalStep, speed, silenceDuration) {
    if (style.ttl.dims[0] !== 1) throw new Error("Single style only")
    silenceDuration = silenceDuration || 0.3
    const maxLen = lang === "ko" ? 120 : 300
    const chunks = chunkText(text, maxLen)
    const langList = new Array(chunks.length).fill(lang)
    let wavCat = []
    let durCat = 0

    for (let i = 0; i < chunks.length; i++) {
      const {wav, duration} = await this._infer([chunks[i]], [langList[i]], style, totalStep, speed)
      if (wavCat.length === 0) {
        wavCat = wav
        durCat = duration[0]
      } else {
        const silence = new Array(Math.floor(silenceDuration * this.sampleRate)).fill(0)
        wavCat = [...wavCat, ...silence, ...wav]
        durCat += duration[0] + silenceDuration
      }
    }
    return {wav: wavCat, duration: [durCat]}
  }

  async _infer(textList, langList, style, totalStep, speed) {
    const bsz = textList.length
    const {textIds, textMask} = this.textProcessor.call(textList, langList)

    const textIdsTensor = new ort.Tensor("int64", new BigInt64Array(textIds.flat().map(x => BigInt(x))), [bsz, textIds[0].length])
    const textMaskTensor = new ort.Tensor("float32", new Float32Array(textMask.flat(2)), [bsz, 1, textMask[0][0].length])

    const dpOut = await this.dpOrt.run({text_ids: textIdsTensor, style_dp: style.dp, text_mask: textMaskTensor})
    const duration = Array.from(dpOut.duration.data)
    for (let i = 0; i < duration.length; i++) duration[i] /= speed

    const textEncOut = await this.textEncOrt.run({text_ids: textIdsTensor, style_ttl: style.ttl, text_mask: textMaskTensor})

    let {xt, latentMask} = this.sampleNoisyLatent(duration, this.sampleRate, this.cfgs.ae.base_chunk_size, this.cfgs.ttl.chunk_compress_factor, this.cfgs.ttl.latent_dim)
    const latentMaskTensor = new ort.Tensor("float32", new Float32Array(latentMask.flat(2)), [bsz, 1, latentMask[0][0].length])

    const totalStepTensor = new ort.Tensor("float32", new Float32Array(bsz).fill(totalStep), [bsz])

    for (let step = 0; step < totalStep; step++) {
      const xtTensor = new ort.Tensor("float32", new Float32Array(xt.flat(2)), [bsz, xt[0].length, xt[0][0].length])
      const out = await this.vectorEstOrt.run({
        noisy_latent: xtTensor,
        text_emb: textEncOut.text_emb,
        style_ttl: style.ttl,
        latent_mask: latentMaskTensor,
        text_mask: textMaskTensor,
        current_step: new ort.Tensor("float32", new Float32Array(bsz).fill(step), [bsz]),
        total_step: totalStepTensor
      })

      const denoised = Array.from(out.denoised_latent.data)
      const latentDim = xt[0].length
      const latentLen = xt[0][0].length
      xt = []
      let idx = 0
      for (let b = 0; b < bsz; b++) {
        const batch = []
        for (let d = 0; d < latentDim; d++) {
          const row = []
          for (let t = 0; t < latentLen; t++) row.push(denoised[idx++])
          batch.push(row)
        }
        xt.push(batch)
      }
    }

    const finalTensor = new ort.Tensor("float32", new Float32Array(xt.flat(2)), [bsz, xt[0].length, xt[0][0].length])
    const vocOut = await this.vocoderOrt.run({latent: finalTensor})
    const wavFull = Array.from(vocOut.wav_tts.data)
    // trim to predicted duration — vocoder output is padded beyond actual speech
    const wavLen = Math.floor(Math.max(...duration) * this.sampleRate)
    return {wav: wavFull.slice(0, wavLen), duration}
  }

  sampleNoisyLatent(duration, sampleRate, baseChunkSize, chunkCompress, latentDim) {
    const bsz = duration.length
    const maxDur = Math.max(...duration)
    const wavLengths = duration.map(d => Math.floor(d * sampleRate))
    const chunkSize = baseChunkSize * chunkCompress
    const latentLen = Math.floor((Math.floor(maxDur * sampleRate) + chunkSize - 1) / chunkSize)
    const latentDimVal = latentDim * chunkCompress

    const xt = []
    for (let b = 0; b < bsz; b++) {
      const batch = []
      for (let d = 0; d < latentDimVal; d++) {
        const row = []
        for (let t = 0; t < latentLen; t++) {
          const u1 = Math.max(0.0001, Math.random())
          const u2 = Math.random()
          row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2))
        }
        batch.push(row)
      }
      xt.push(batch)
    }

    const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize))
    const latentMask = latentLengths.map(len => {
      const row = new Array(latentLen).fill(0.0)
      for (let j = 0; j < Math.min(len, latentLen); j++) row[j] = 1.0
      return [row]
    })

    for (let b = 0; b < bsz; b++)
      for (let d = 0; d < latentDimVal; d++)
        for (let t = 0; t < latentLen; t++)
          xt[b][d][t] *= latentMask[b][0][t]

    return {xt, latentMask}
  }
}

function chunkText(text, maxLen) {
  const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim())
  const chunks = []
  for (const paragraph of paragraphs) {
    const sentences = paragraph.trim().split(/(?<=[.!?])\s+/)
    let current = ""
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLen) {
        current += (current ? " " : "") + sentence
      } else {
        if (current) chunks.push(current.trim())
        current = sentence
      }
    }
    if (current) chunks.push(current.trim())
  }
  return chunks
}

function writeWavFile(audioData, sampleRate) {
  const dataSize = audioData.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, dataSize, true)

  const int16 = new Int16Array(audioData.length)
  for (let i = 0; i < audioData.length; i++) {
    int16[i] = Math.floor(Math.max(-1, Math.min(1, audioData[i])) * 32767)
  }
  new Uint8Array(buffer, 44).set(new Uint8Array(int16.buffer))

  return buffer
}
