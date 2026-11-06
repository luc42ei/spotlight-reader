
var googleTranslateTtsEngine = new GoogleTranslateTtsEngine();
var amazonPollyTtsEngine = new AmazonPollyTtsEngine();
var googleWavenetTtsEngine = new GoogleWavenetTtsEngine();
var ibmWatsonTtsEngine = new IbmWatsonTtsEngine();
var phoneTtsEngine = new PhoneTtsEngine();
var openaiTtsEngine = new OpenaiTtsEngine();
var azureTtsEngine = new AzureTtsEngine();
const piperTtsEngine = new PiperTtsEngine()
const supertonicTtsEngine = new SupertonicTtsEngine()


//synthesized audio cache
const cache = {
  entries: new Map(),
  maxEntries: 5,
  fetchCached(key, fetchFn, destroyFn) {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
      return entry.promise
    }
    const promise = Promise.resolve().then(fetchFn).catch(err => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key)
      throw err
    })
    this.entries.set(key, {promise, destroyFn})
    while (this.entries.size > this.maxEntries) {
      const [oldestKey, oldest] = this.entries.entries().next().value
      oldest.promise.then(value => oldest.destroyFn?.(value)).catch(() => {})
      this.entries.delete(oldestKey)
    }
    return promise
  }
}


/*
interface Options {
  voice: {
    voiceName: string
    autoSelect?: boolean
  }
  lang: string
  rate?: number
}

interface Event {
  type: string
}

interface Voice {
  voiceName: string
  lang: string
}

interface TtsEngine {
  speak: function(text: string, opts: Options, playbackState$: Observable<"paused"|"resumed">): Observable<TtsEvent>
  getVoices: function(): Voice[]
}
*/

function DummyTtsEngine() {
  this.getVoices = function() {
    return Promise.resolve([]);
  }
}


function TimeoutTtsEngine(baseEngine, startTimeout, endTimeout) {
  let speakSub
  this.speak = function(text, options, onEvent) {
    speakSub = new rxjs.Observable(observer => {
      baseEngine.speak(text, options, event => observer.next(event))
    }).pipe(
      rxjs.timeout({
        first: startTimeout,
        with() {
          console.debug(`No 'start' event after ${startTimeout}, will call stop() and retry once`)
          baseEngine.stop()
          return rxjs.throwError(() => new Error("Timeout, TTS never started, try picking another voice?"))
        }
      }),
      rxjs.retry(1),
      rxjs.mergeMap(event =>
        rxjs.iif(
          () => event.type == "start",
          rxjs.timer(endTimeout).pipe(
            rxjs.map(() => {
              console.debug(`No 'end' event after ${endTimeout}, will call stop() and generate 'end'`)
              baseEngine.stop()
              return {type: "end", charIndex: text.length}
            }),
            rxjs.startWith(event)
          ),
          rxjs.of(event)
        )
      ),
      rxjs.catchError(error => rxjs.of({type: "error", error})),
      rxjs.takeWhile(event => event.type != "end" && event.type != "error", true)
    ).subscribe(onEvent)
  }
  this.stop = function() {
    if (speakSub) speakSub.unsubscribe()
    baseEngine.stop();
  }
  this.isSpeaking = baseEngine.isSpeaking;
}


function GoogleTranslateTtsEngine() {
  this.ready = function() {
    return googleTranslateReady();
  };
  this.speak = function(utterance, options, playbackState$) {
    options.rateAdjust = 1.1
    const urlPromise = getAudioUrl(utterance, options)
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  };
  this.getVoices = function() {
    return voices;
  }
  function getAudioUrl(text, {voice: {lang}}) {
    assert(text && lang);
    return cache.fetchCached(
      JSON.stringify([text, lang]),
      () => googleTranslateSynthesizeSpeech(text, lang)
      //data URL, no destroy()
    )
  }
  var voices = [
      {"voice_name": "GoogleTranslate Afrikaans", "lang": "af", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Albanian", "lang": "sq", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Arabic", "lang": "ar", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Armenian", "lang": "hy", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bengali", "lang": "bn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bosnian", "lang": "bs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bulgarian", "lang": "bg", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Catalan", "lang": "ca", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Chinese", "lang": "zh-CN", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Croatian", "lang": "hr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Czech", "lang": "cs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Danish", "lang": "da", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Dutch", "lang": "nl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate English", "lang": "en", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Esperanto", "lang": "eo", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Estonian", "lang": "et", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Filipino", "lang": "fil", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Finnish", "lang": "fi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate French", "lang": "fr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate German", "lang": "de", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Greek", "lang": "el", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Gujarati", "lang": "gu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hebrew", "lang": "he", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hindi", "lang": "hi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hungarian", "lang": "hu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Icelandic", "lang": "is", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Indonesian", "lang": "id", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Italian", "lang": "it", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Japanese", "lang": "ja", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Javanese", "lang": "jw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Kannada", "lang": "kn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Khmer", "lang": "km", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Korean", "lang": "ko", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latin", "lang": "la", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latvian", "lang": "lv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Macedonian", "lang": "mk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malay", "lang": "ms", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malayalam", "lang": "ml", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Marathi", "lang": "mr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Myanmar (Burmese)", "lang": "my", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Nepali", "lang": "ne", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Norwegian", "lang": "no", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Polish", "lang": "pl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Portuguese", "lang": "pt", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Romanian", "lang": "ro", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Russian", "lang": "ru", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Serbian", "lang": "sr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sinhala", "lang": "si", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Slovak", "lang": "sk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Spanish", "lang": "es", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sundanese", "lang": "su", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swahili", "lang": "sw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swedish", "lang": "sv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tagalog", "lang": "tl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tamil", "lang": "ta", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Telugu", "lang": "te", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Thai", "lang": "th", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Turkish", "lang": "tr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Ukrainian", "lang": "uk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Urdu", "lang": "ur", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Vietnamese", "lang": "vi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Welsh", "lang": "cy", "event_types": ["start", "end", "error"]}
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
}


function AmazonPollyTtsEngine() {
  var getPolly = lazy(createPolly)
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options)
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  };
  this.getVoices = async function() {
    try {
      const {awsCreds, pollyVoices} = await getSettings(["awsCreds", "pollyVoices"])
      if (!awsCreds) return []
      if (pollyVoices && pollyVoices.expire > Date.now()) return pollyVoices.list
      const list = await fetchVoices()
      await updateSettings({pollyVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  async function fetchVoices() {
    const polly = await getPolly()
    const data = await polly.describeVoices().promise()
    const voices = []
    for (const voice of data.Voices) {
      assert(voice.SupportedEngines && voice.Id)
      if (voice.SupportedEngines.includes("standard")) voices.push(voice);
      if (voice.SupportedEngines.includes("neural")) voices.push({...voice, Style: "neural"})
      if (polly.newscasterVoices.includes(voice.Id)) voices.push({...voice, Style: "newscaster"})
      if (polly.conversationalVoices.includes(voice.Id)) voices.push({...voice, Style: "conversational"})
    }
    return voices.map(voice => {
      assert(voice.Gender)
      let voiceName = `AmazonPolly ${voice.LanguageName} (${voice.Id})`;
      if (voice.Style) voiceName += ` +${voice.Style}`;
      return {
        voiceName,
        lang: voice.LanguageCode,
        langs: voice.AdditionalLanguageCodes
          ? [voice.LanguageCode, ...voice.AdditionalLanguageCodes]
          : undefined,
        gender: voice.Gender.toLowerCase(),
      }
    })
  }
  function getAudioUrl(text, {lang, voice}) {
    assert(text && lang && voice);
    var matches = voice.voiceName.match(/^AmazonPolly .* \((\w+)\)( \+\w+)?$/);
    var voiceId = matches[1];
    var style = matches[2] && matches[2].substr(2);
    return cache.fetchCached(
      JSON.stringify([text, voiceId, style]),
      async () => {
        const polly = await getPolly()
        const blob = await polly.synthesizeSpeech(getOpts(text, voiceId, style)).promise()
          .catch(err => { throw classifyAwsError(err, "polly.us-east-1.amazonaws.com") })
        return URL.createObjectURL(blob);
      },
      blobUrl => URL.revokeObjectURL(blobUrl)
    )
  }
  function createPolly() {
    return getSettings(["awsCreds"])
      .then(function(items) {
        if (!items.awsCreds) throw new Error("Missing AWS credentials");
        return new AWS.Polly({
          region: "us-east-1",
          accessKeyId: items.awsCreds.accessKeyId,
          secretAccessKey: items.awsCreds.secretAccessKey
        })
      })
  }
  function getOpts(text, voiceId, style) {
    switch (style) {
      case "newscaster":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="news">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "conversational":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="conversational">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "neural":
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId,
          Engine: "neural"
        }
      default:
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId
        }
    }
  }
}


function GoogleWavenetTtsEngine() {
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options)
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  };
  this.getVoices = function() {
    return getSettings(["wavenetVoices", "gcpCreds"])
      .then(function(items) {
        if (!items.wavenetVoices || Date.now()-items.wavenetVoices[0].ts > 24*3600*1000) updateVoices();
        var listvoices = items.wavenetVoices || voices;
        var creds = items.gcpCreds;
        return listvoices.filter(
          function(voice) {
            // include all voices or exclude only studio voices.
            return ((creds && creds.enableStudio) || !isGoogleStudio(voice));
          });
      })
  }
  this.getFreeVoices = function() {
    return this.getVoices()
      .then(function(items) {
        return items.filter(function(item) {
          return item.voiceName.match(/^GoogleStandard /);
        })
      })
  }
  function updateVoices() {
    ajaxGet(config.serviceUrl + "/read-aloud/list-voices/google")
      .then(JSON.parse)
      .then(function(list) {
        list[0].ts = Date.now();
        updateSettings({wavenetVoices: list});
      })
  }
  // Italic passages become <emphasis level="strong"> — Chirp 3: HD honors the
  // tag (verified by measurement) even though Google's docs don't list it for
  // that voice type, and the older types support full SSML. Studio is the one
  // exception: it explicitly drops <emphasis>.
  const SSML_EMPHASIS_TYPES = ["Chirp3-HD", "Chirp-HD", "Neural2", "Wavenet", "Standard"];

  function xmlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function buildSsml(text, ranges) {
    let out = "<speak>", pos = 0;
    for (const [start, end] of ranges) {
      if (start < pos) continue;
      out += xmlEscape(text.slice(pos, start))
        + '<emphasis level="strong">' + xmlEscape(text.slice(start, end)) + '</emphasis>';
      pos = end;
    }
    return out + xmlEscape(text.slice(pos)) + "</speak>";
  }

  function getAudioUrl(text, {voice, emphasis}) {
    assert(text && voice);
    return cache.fetchCached(
      JSON.stringify([text, voice.voiceName, voice.lang, emphasis || null]),
      () => {
        var matches = voice.voiceName.match(/^Google(\S+) .* \((\w+)\)$/);
        const voiceType = matches[1];
        const speakerId = voiceType == "Chirp3-HD" ? matches[2] : matches[2][0];
        var endpoint = matches[1] == "Neural2" ? "us-central1-texttospeech.googleapis.com" : "texttospeech.googleapis.com";
        return getSettings(["gcpCreds", "gcpToken"])
          .then(function(settings) {
            function request(input) {
              var postData = {
                input: input,
                voice: {
                  languageCode: voice.lang,
                  name: voice.lang + "-" + voiceType + "-" + speakerId
                },
                audioConfig: {
                  audioEncoding: "OGG_OPUS",
                }
              }
              if (settings.gcpCreds) return ajaxPost("https://" + endpoint + "/v1/text:synthesize?key=" + settings.gcpCreds.apiKey, postData, "json");
              if (!settings.gcpToken) throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
              return ajaxPost("https://cxl-services.appspot.com/proxy?url=https://texttospeech.googleapis.com/v1beta1/text:synthesize&token=" + settings.gcpToken, postData, "json")
                .catch(function(err) {
                  console.error(err);
                  throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
                })
            }
            // Google bills SSML tags as characters, so only chunks that carry an
            // emphasis go out as SSML; everything else stays plain text.
            if (!(emphasis && emphasis.length && SSML_EMPHASIS_TYPES.includes(voiceType))) return request({text: text});
            // <emphasis> is undocumented for Chirp 3: HD — if Google ever stops
            // accepting it, read the chunk plainly instead of failing playback.
            return request({ssml: buildSsml(text, emphasis)})
              .catch(function(err) {
                console.warn("SSML emphasis rejected, falling back to plain text", err);
                return request({text: text});
              })
          })
          .then(function(responseText) {
            var data = JSON.parse(responseText);
            return "data:audio/ogg;codecs=opus;base64," + data.audioContent;
          })
      }
      //data URL, no destroy()
    )
  }
  var voices = [
    {"voiceName":"GoogleStandard Spanish; Castilian (Anna)","lang":"es-ES","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Anna)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Benjamin)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Christopher)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Diane)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard French (Elizabeth)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Anna)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Elizabeth)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Anna)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Benjamin)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Russian (Caroline)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Daniel)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Diane)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Anna)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Benjamin)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Christopher)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Anna)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Bianca)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Christopher)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Daniel)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Anna)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Bianca)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Christopher)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Daniel)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Anna)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Benjamin)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Caroline)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Daniel)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Filipino (Anna)","lang":"fil-PH","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Anna)","lang":"id-ID","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Benjamin)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Indonesian (Christopher)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Anna)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Benjamin)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Christopher)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Diane)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Elizabeth)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Czech (Anna)","lang":"cs-CZ","gender":"female"},
    {"voiceName":"GoogleStandard Greek, Modern (Anna)","lang":"el-GR","gender":"female"},
    {"voiceName":"GoogleStandard Brazilian Portuguese (Anna)","lang":"pt-BR","gender":"female"},
    {"voiceName":"GoogleStandard Hungarian (Anna)","lang":"hu-HU","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Elizabeth)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Anna)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Benjamin)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Christopher)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Diane)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Slovak (Anna)","lang":"sk-SK","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Anna)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Benjamin)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Turkish (Caroline)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Diane)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Ethan)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Ukrainian (Anna)","lang":"uk-UA","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Anna)","lang":"en-IN","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Benjamin)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Indian English (Christopher)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Anna)","lang":"hi-IN","gender":"female"},
    {"voiceName":"GoogleStandard Hindi (Benjamin)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Christopher)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Danish (Anna)","lang":"da-DK","gender":"female"},
    {"voiceName":"GoogleStandard Finnish (Anna)","lang":"fi-FI","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Anna)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Benjamin)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Christopher)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Diane)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Elizabeth)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Anna)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Benjamin)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Caroline)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Daniel)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Swedish (Anna)","lang":"sv-SE","gender":"female"},
    {"voiceName":"GoogleStandard British English (Anna)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Benjamin)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard British English (Caroline)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Daniel)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard US English (Benjamin)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Caroline)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard US English (Daniel)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Elizabeth)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard German (Anna)","lang":"de-DE","gender":"female"},
    {"voiceName":"GoogleStandard German (Benjamin)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard German (Ethan)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Anna)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Benjamin)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Caroline)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Daniel)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Anna)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Benjamin)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Caroline)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Daniel)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard French (Anna)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Benjamin)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard French (Caroline)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Daniel)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Bianca)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Christopher)","lang":"it-IT","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Daniel)","lang":"it-IT","gender":"male"},
  ]
}


function IbmWatsonTtsEngine() {
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options)
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  };
  this.getVoices = function() {
    return getSettings(["watsonVoices", "ibmCreds"])
      .then(function(items) {
        if (!items.ibmCreds) return [];
        if (items.watsonVoices && Date.now()-items.watsonVoices[0].ts < 24*3600*1000) return items.watsonVoices;
        return fetchVoices(items.ibmCreds.apiKey, items.ibmCreds.url)
          .then(function(list) {
            list[0].ts = Date.now();
            updateSettings({watsonVoices: list}).catch(console.error);
            return list;
          })
          .catch(function(err) {
            console.error(err);
            return [];
          })
      })
  }
  this.fetchVoices = fetchVoices;

  function getAudioUrl(text, {voice}) {
    assert(text && voice);
    var matches = voice.voiceName.match(/^IBM-Watson .* \((\w+)\)$/);
    var voiceName = voice.lang + "_" + matches[1] + "Voice";
    return cache.fetchCached(
      JSON.stringify([text, voiceName]),
      async () => {
        const settings = await getSettings(["ibmCreds"])
        const blob = await ajaxGet({
          url: settings.ibmCreds.url + "/v1/synthesize?text=" + encodeURIComponent(escapeHtml(text)) + "&voice=" + encodeURIComponent(voiceName) + "&accept=" + encodeURIComponent("audio/ogg;codecs=opus"),
          headers: {
            Authorization: "Basic " + btoa("apikey:" + settings.ibmCreds.apiKey)
          },
          responseType: "blob"
        })
        return URL.createObjectURL(blob);
      },
      blobUrl => URL.revokeObjectURL(blobUrl)
    )
  }
  function fetchVoices(apiKey, url) {
    return ajaxGet({
        url: url + "/v1/voices",
        headers: {
          Authorization: "Basic " + btoa("apikey:" + apiKey)
        }
      })
      .then(JSON.parse)
      .then(function(data) {
        return data.voices.map(item => {
          item.description = item.description.replace(/Chinese \((Mandarin|Cantonese)\)/, "Chinese, $1");
          return {
            voiceName: "IBM-Watson " + item.description.split(/: | male| female| \(/)[1] + " (" + item.name.slice(item.language.length+1, -5) + ")",
            lang: item.language,
            gender: item.gender,
          }
        })
      })
  }
}


function PhoneTtsEngine() {
  var isSpeaking = false
  var conn
  const pendingRequests = new Map()
  const getPairingCode = lazy(() => 100000 + Math.floor(Math.random() * 900000))
  const getPeer = lazy(async () => {
    const peer = new Peer("readaloud-" + getPairingCode(), {debug: 2})
    await new Promise((f,r) => peer.once("open", f).once("error", r))
    peer.on("connection", newConn => {
      const makeError = reason => new Error(JSON.stringify({code: "error_phone_disconnected", reason}))
      newConn.readyPromise = new Promise((fulfill, reject) => {
        newConn.once("open", fulfill)
          .once("error", err => reject(makeError(err.message || err)))
      })
      newConn.once("close", () => newConn.readyPromise = Promise.reject(makeError("Connection lost")))
      newConn.on("error", console.error)
      newConn.on("data", res => {
        const pending = pendingRequests.get(res.id)
        if (pending) {
          if (res.error) pending.reject(new Error(res.error))
          else pending.fulfill(res.value)
        }
        else {
          console.warn("Response received but no pending request", res)
        }
      })
      newConn.peerConnection.addEventListener("connectionstatechange", () => {
        //https://bugs.chromium.org/p/chromium/issues/detail?id=982793#c15
        if (newConn.peerConnection.connectionState == "failed") newConn.close()
      })
      if (conn) conn.close()
      conn = newConn
    })
    window.addEventListener("beforeunload", () => peer.destroy())
    return peer
  })
  this.startPairing = async function() {
    if (conn) {
      conn.close()
      conn = null
    }
    const peer = await getPeer()
    if (peer.disconnected) peer.reconnect()
    return getPairingCode()
  }
  this.isPaired = async function() {
    return conn != null
  }
  async function sendRequest(req, timeout) {
    req.id = String(Math.random())
    await conn.readyPromise
    conn.send(req)
    const responsePromise = new Promise((fulfill, reject) => pendingRequests.set(req.id, {fulfill, reject}))
    try {
      return await promiseTimeout(timeout || 5000, "Request timed out", responsePromise)
    }
    catch(err) {
      if (err.message == "Request timed out") {
        console.warn("Request timed out, assuming phone connection lost")
        conn.close()
      }
      throw err
    }
    finally {
      pendingRequests.delete(req.id)
    }
  }
  this.speak = function(text, options, onEvent) {
    if (!conn) {
      onEvent({type: "error", error: new Error(JSON.stringify({code: "error_phone_not_connected"}))})
      return
    }
    sendRequest({
        method: "speak",
        text,
        options: {
          lang: options.lang,
          rate: options.rate,
        }
      })
      .then(({speechId}) => {
        onEvent({type: "start", charIndex: 0})
        isSpeaking = true
        sendRequest({method: "waitFinish", speechId}, 3*60*1000)
          .then(() => onEvent({type: "end", charIndex: text.length}),
            err => {
              if (err.message != "interrupted") onEvent({type: "error", error: err})
            })
          .finally(() => isSpeaking = false)
      })
      .catch(err => {
        if (err.message != "canceled") onEvent({type: "error", error: err})
      })
  }
  this.stop = function() {
    if (!conn) return;
    sendRequest({method: "stop"}).catch(console.error)
  }
  this.pause = function() {
    sendRequest({method: "pause"}).catch(console.error)
  }
  this.resume = function() {
    sendRequest({method: "resume"}).catch(console.error)
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking)
  }
  this.getVoices = function() {
    return [
      {voiceName: "Use My Phone", remote: false, isUseMyPhone: true},
    ]
  }
}


function OpenaiTtsEngine() {
  this.defaultEndpointUrl = "https://api.openai.com/v1"
  this.defaultVoiceList = [
    {voice: "alloy", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "ash", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "coral", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "echo", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "fable", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "onyx", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "nova", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "sage", langs: ["en-US", "zh-CN"], model: "tts-1"},
    {voice: "shimmer", langs: ["en-US", "zh-CN"], model: "tts-1"},
  ]
  this.test = async function({apiKey, url, voiceList}) {
    const host = new URL(url).host
    const res = await fetch(url + "/models", {
      headers: {"Authorization": "Bearer " + apiKey}
    }).catch(err => { throw classifyFetchError(err, host) })
    if (!res.ok) {
      const error = await res.json().then(x => x.error).catch(() => null)
      if (error) throw error
      throwHttpError(res, host)
    }
  }
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options)
    // null = the server returned no audio (e.g. a chunk that is only punctuation)
    // → skip the chunk instead of failing the whole read on a decode error.
    return rxjs.from(urlPromise).pipe(
      rxjs.switchMap(url => url != null
        ? playAudio(Promise.resolve(url), options, playbackState$)
        : playbackState$.pipe(
            rxjs.filter(state => state == "resumed"),
            rxjs.take(1),
            rxjs.concatMap(() => rxjs.of({type: "start"}, {type: "end"}))
          ))
    )
  }
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  }
  this.getVoices = async function() {
    const openaiCreds = await getSetting("openaiCreds")
    const voiceList = openaiCreds ? (openaiCreds.voiceList || this.defaultVoiceList) : []
    return voiceList.map(({voice, lang, langs}) => ({
      voiceName: "OpenAI " + voice,
      lang,
      langs
    }))
  }
  function getAudioUrl(text, {voice}) {
    assert(text && voice)
    const voiceId = voice.voiceName.slice(7)
    return cache.fetchCached(
      JSON.stringify([text, voiceId]),
      async () => {
        const {openaiCreds} = await getSettings(["openaiCreds"])
        const voiceInfo = openaiCreds.voiceList.find(x => x.voice == voiceId)
        assert(voiceInfo, "Voice not found " + voiceId)
        const host = new URL(openaiCreds.url).host
        const res = await fetch(openaiCreds.url + "/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(
              openaiCreds.apiKey ? {
                "Authorization": "Bearer " + openaiCreds.apiKey
              } : null
            )
          },
          body: JSON.stringify({
            model: voiceInfo.model,
            input: text,
            voice: voiceInfo.voice,
            instructions: voiceInfo.instructions,
            response_format: "mp3",
          })
        }).catch(err => { throw classifyFetchError(err, host) })
        if (!res.ok) {
          const error = await res.json().then(x => x.error).catch(() => null)
          if (error) throw error
          throwHttpError(res, host)
        }
        const audio = await res.blob()
        return await isEmptyAudio(audio) ? null : URL.createObjectURL(audio)
      },
      blobUrl => { if (blobUrl != null) URL.revokeObjectURL(blobUrl) }
    )
  }
  // Empty body, a WAV with no samples, or an MP3 that is only an ID3 tag.
  // Unknown/malformed formats are left to the decoder so real errors stay visible.
  async function isEmptyAudio(blob) {
    if (blob.size == 0) return true
    if (blob.size > 4096) return false
    const data = new DataView(await blob.arrayBuffer())
    const tag = offset => data.getUint32(offset, false)
    // MP3: "ID3" + version(2) + flags(1) + syncsafe size(4); nothing after the tag
    if (data.byteLength >= 10 && (tag(0) >>> 8) == 0x494433) {
      const size = (data.getUint8(6) << 21) | (data.getUint8(7) << 14) | (data.getUint8(8) << 7) | data.getUint8(9)
      const footer = (data.getUint8(5) & 0x10) ? 10 : 0
      return 10 + size + footer >= data.byteLength
    }
    // WAV: walk the chunks (metadata chunks are optional) to the data chunk
    if (data.byteLength < 12 || tag(0) != 0x52494646 || tag(8) != 0x57415645) return false
    for (let offset = 12; offset + 8 <= data.byteLength;) {
      const size = data.getUint32(offset + 4, true)
      const start = offset + 8
      // Streaming servers may write 0xFFFFFFFF until the stream ends.
      if (tag(offset) == 0x64617461) return size == 0 || start == data.byteLength
      if (start + size > data.byteLength) return false
      offset = start + size + (size % 2)
    }
    return false
  }
}


function AzureTtsEngine() {
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = getAudioUrl(utterance, options)
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options)
      .catch(console.error)
  };
  this.getVoices = async function() {
    try {
      const {azureCreds, azureVoices} = await getSettings(["azureCreds", "azureVoices"])
      if (!azureCreds) return []
      if (azureVoices && azureVoices.expire > Date.now()) return azureVoices.list
      const list = await this.fetchVoices(azureCreds.region, azureCreds.key)
      await updateSettings({azureVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  this.fetchVoices = async function(region, key) {
    const host = `${region}.tts.speech.microsoft.com`
    const res = await fetch(`https://${host}/cognitiveservices/voices/list`, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
      }
    }).catch(err => { throw classifyFetchError(err, host) })
    if (!res.ok) throwHttpError(res, host)
    const voices = await res.json()
    return voices.map(item => {
      const name = item.ShortName.split("-")[2]
      return {
        voiceName: "Azure " + item.LocaleName + " - " + name,
        lang: item.Locale,
        gender: item.Gender == "Male" ? "male" : "female",
      }
    })
  }
  function getAudioUrl(text, {lang, voice}) {
    const matches = voice.voiceName.match(/^Azure .* - (\w+)$/)
    const voiceName = voice.lang + "-" + matches[1]
    return cache.fetchCached(
      JSON.stringify([text, lang, voiceName]),
      async () => {
        const {azureCreds} = await getSettings(["azureCreds"])
        const {region, key} = azureCreds
        const host = `${region}.tts.speech.microsoft.com`
        const res = await fetch(`https://${host}/cognitiveservices/v1`, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "ogg-48khz-16bit-mono-opus",
          },
          body: `<speak version='1.0' xml:lang='${lang}'><voice name='${voiceName}'>${escapeXml(text)}</voice></speak>`
        }).catch(err => { throw classifyFetchError(err, host) })
        if (!res.ok) throwHttpError(res, host)
        const blob = await res.blob()
        return URL.createObjectURL(blob)
      },
      blobUrl => URL.revokeObjectURL(blobUrl)
    )
  }
}


function PiperTtsEngine() {
  let control = null
  let isSpeaking = false
  this.speak = function(utterance, options, onEvent) {
    const piperPromise = rxjs.firstValueFrom(piperObservable)
    control = new rxjs.Subject()
    control
      .pipe(
        rxjs.startWith("speak"),
        rxjs.concatMap(async cmd => {
          const piper = await piperPromise
          switch (typeof cmd == "string" ? cmd : cmd.type) {
            case "speak":
              return piper.sendRequest("speak", {
                utterance,
                voiceName: options.voice.voiceName,
                rate: options.rate,
                externalPlayback: options.rate && options.rate != 1,
              })
            case "pause":
              return piper.sendRequest("pause")
            case "resume":
              return piper.sendRequest("resume")
            case "stop":
              return piper.sendRequest("stop")
                .then(() => Promise.reject({name: "interrupted", message: "Playback interrupted"}))
            case "forward":
              return piper.sendRequest("forward")
            case "rewind":
              return piper.sendRequest("rewind")
            case "seek":
              return piper.sendRequest("seek", {index: cmd.index})
          }
        }),
        rxjs.ignoreElements(),
        rxjs.mergeWith(piperCallbacks),
        rxjs.map(event => {
          if (event.type == "error") throw event.error
          return event
        }),
        rxjs.takeWhile(event => event.type != "end")
      )
      .subscribe({
        next(event) {
          if (event.type == "start") isSpeaking = true
          onEvent(event)
        },
        complete() {
          onEvent({type: "end"})
        },
        error(err) {
          if (err.name != "interrupted") onEvent({type: "error", error: err})
        }
      })
      .add(() => {
        isSpeaking = false
        control = null
      })
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking)
  }
  this.pause = function() {
    control?.next("pause")
  }
  this.resume = function() {
    control?.next("resume")
  }
  this.stop = function() {
    control?.next("stop")
  }
  this.forward = function() {
    control?.next("forward")
  }
  this.rewind = function() {
    control?.next("rewind")
  }
  this.seek = function(index) {
    control?.next({type: "seek", index})
  }
}


function SupertonicTtsEngine() {
  // Firefox extension workers aren't cross-origin isolated, so ONNX Runtime can't
  // use threads inside one worker. Instead we run extra workers, each with its own
  // copy of the models (~0.5-0.6 GB RAM), and spread prefetched chunks across
  // them — measured 1.6x throughput with 2 workers, 2x with 3.
  const workers = []
  let nextId = 0
  const prefetchCache = new Map()

  function createWorker() {
    const w = {worker: new Worker(brapi.runtime.getURL("js/supertonic-worker.js")), pending: 0, ready: null}
    workers.push(w)
    return w
  }

  function primary() {
    return workers[0] || createWorker()
  }

  function postWorker(w, method, data) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      function handler(e) {
        if (e.data.id === id) {
          w.worker.removeEventListener("message", handler)
          w.pending--
          if (e.data.error) reject(new Error(e.data.error))
          else resolve(e.data.result)
        }
      }
      w.pending++
      w.worker.addEventListener("message", handler)
      w.worker.postMessage({id, method, ...data})
    })
  }

  function loadModels(w) {
    if (!w.ready) {
      w.ready = postWorker(w, "loadModels", {})
        .then(() => w.loaded = true)
        .catch(err => {
          w.ready = null
          throw err
        })
    }
    return w.ready
  }

  async function getConfig() {
    const settings = await getSettings(["supertonicSteps", "supertonicParallel"])
    return {
      steps: [5, 6].includes(settings.supertonicSteps) ? settings.supertonicSteps : defaults.supertonicSteps,
      parallel: settings.supertonicParallel != null ? settings.supertonicParallel : defaultSupertonicParallel()
    }
  }

  // 3 workers only where they leave cores for the browser and the page.
  function parallelWorkerCount() {
    return (navigator.hardwareConcurrency || 2) >= 6 ? 3 : 2
  }

  // Synchronous on purpose: the caller posts to the chosen worker right away,
  // so `pending` is up to date before the next prefetch picks.
  function pickWorker(parallel) {
    if (parallel) {
      // Load the extra copies in the background; until they're ready, everything
      // goes to the primary so the first chunk isn't held up.
      while (workers.length < parallelWorkerCount()) loadModels(createWorker()).catch(console.error)
    } else {
      for (const w of workers.splice(1)) {
        if (w.pending) workers.push(w)
        else w.worker.terminate()
      }
    }
    const usable = parallel ? workers.filter(w => w.loaded) : workers.slice(0, 1)
    return usable.reduce((a, b) => b.pending < a.pending ? b : a)
  }

  // The model renders the rate itself up to 1.3x (shorter audio, proportionally
  // less compute); the player time-stretches the rest. Above ~1.3x the model
  // swallows words: ASR word error rate on a real article was 5-9 % at <=1.3x,
  // 12-13 % at 1.5x and 37-48 % at 1.8x, vs. 10-11 % for 1.3x model + stretch
  // to 1.8x.
  function modelSpeed(rate) {
    return Math.min(1.3, Math.max(0.8, rate || 1))
  }

  async function synthesize(utterance, options) {
    const lang = parseLang(options.lang || "en").lang
    const voiceName = (options.voice.voiceName || "").replace("Supertonic ", "")
    const {steps, parallel} = await getConfig()
    await loadModels(primary())
    const wavBuf = await postWorker(pickWorker(parallel), "speak", {text: utterance, lang, voiceName, speed: modelSpeed(options.rate), steps})
    return URL.createObjectURL(new Blob([wavBuf], {type: "audio/wav"}))
  }

  function cacheKey(utterance, options) {
    return utterance + "\x00" + options.voice.voiceName + "\x00" + (options.rate || 1)
  }

  // Parallel workers only stay busy if there's more than one chunk queued per
  // worker; short chunks (headings) cost more compute than their audio lasts.
  this.prefetchDepth = 4

  this.isReady = function() {
    return workers.length > 0 && !!workers[0].loaded
  }

  this.speak = function(utterance, options, playbackState$) {
    const key = cacheKey(utterance, options)
    const cached = prefetchCache.get(key)
    const urlPromise = cached || synthesize(utterance, options)
    prefetchCache.delete(key)
    const rate = options.rate || 1
    return playAudio(urlPromise, {...options, rate: rate / modelSpeed(rate)}, playbackState$)
  }

  this.prefetch = function(utterance, options) {
    const key = cacheKey(utterance, options)
    if (!prefetchCache.has(key)) {
      prefetchCache.set(key, synthesize(utterance, options).catch(err => {
        prefetchCache.delete(key)
        throw err
      }))
    }
  }

  this.getVoices = function() {
    const langs = ["en", "ko", "es", "pt", "fr", "de", "ja", "ar", "bg", "cs", "da", "el", "et", "fi", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi"]
    return ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"]
      .map(id => ({voiceName: "Supertonic " + id, lang: "en", langs}))
  }

  this.installModels = function(onProgress) {
    const w = primary()
    function progressHandler(e) {
      if (e.data.type === "progress" && onProgress) onProgress(e.data.step, e.data.total)
    }
    w.worker.addEventListener("message", progressHandler)
    return postWorker(w, "cacheModels", {})
      .finally(() => w.worker.removeEventListener("message", progressHandler))
  }
}
