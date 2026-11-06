
const isEmbedded = top != self
var queryString = new URLSearchParams(location.search)
var activeDoc;
var playbackError = null;
var lastUrlPromise = Promise.resolve(null)


const piperSubject = new rxjs.Subject()
const piperObservable = rxjs.defer(() => {
    createPiperFrame()
    return piperSubject
  })
  .pipe(
    rxjs.shareReplay({bufferSize: 1, refCount: false}),
    rxjs.tap(raisePiperFrame)
  )
const piperCallbacks = new rxjs.Subject()
const piperDispatcher = makeDispatcher("piper-host", {
  advertiseVoices({voices}, sender) {
    updateSettings({piperVoices: voices})
    piperSubject.next(sender)
  },
  onStart: args => piperCallbacks.next({type: "start", ...args}),
  onSentence: args => piperCallbacks.next({type: "sentence", ...args}),
  onParagraph: args => piperCallbacks.next({type: "paragraph", ...args}),
  onEnd: args => piperCallbacks.next({type: "end", ...args}),
  onError: args => piperCallbacks.next({type: "error", ...args}),
  audioPlay: args => audioPlayer.play(args.src, args.rate, args.volume),
  audioPause: () => audioPlayer.pause(),
  audioResume: () => audioPlayer.resume(),
})




const audioPlayer = immediate(() => {
  let current
  return {
    play(src, rate, volume) {
      if (current) current.playback.unsubscribe()
      const isBlob = src instanceof Blob
      const url = isBlob ? URL.createObjectURL(src) : src
      const playbackState$ = new rxjs.BehaviorSubject("resumed")
      return new Promise((fulfill, reject) => {
        current = {
          playbackState$,
          playback: playAudio(Promise.resolve(url), {rate, volume}, playbackState$).subscribe({
            complete: fulfill,
            error: reject
          })
        }
        if (isBlob) current.playback.add(() => URL.revokeObjectURL(url))
      })
    },
    pause() {
      if (current) current.playbackState$.next("paused")
    },
    resume() {
      if (current) current.playbackState$.next("resumed")
    }
  }
})


const fasttextSubject = new rxjs.Subject()
const fasttextObservable = rxjs.defer(() => {
    createFasttextFrame()
    return fasttextSubject
  })
  .pipe(
    rxjs.startWith(null),
    rxjs.shareReplay({bufferSize: 1, refCount: false})
  )
const fasttextDispatcher = makeDispatcher("fasttext-host", {
  onServiceReady(args, sender) {
    fasttextSubject.next(sender)
  }
})


window.addEventListener("message", event => {
  const send = message => event.source.postMessage(message, {targetOrigin: event.origin})

  piperDispatcher.dispatch(event.data, {
    sendRequest(method, args) {
      const id = String(Math.random())
      send({from: "piper-host", to: "piper-service", type: "request", id, method, args})
      return piperDispatcher.waitForResponse(id)
    }
  }, send)

  fasttextDispatcher.dispatch(event.data, {
    sendRequest(method, args) {
      const id = String(Math.random())
      send({from: "fasttext-host", to: "fasttext-service", type: "request", id, method, args})
      return fasttextDispatcher.waitForResponse(id)
    }
  }, send)
})


const idleSubject = new rxjs.BehaviorSubject(true)

if (queryString.has("autoclose")) {
  rxjs.combineLatest(
    idleSubject,
    piperSubject.pipe(rxjs.startWith(null))
  ).pipe(
    rxjs.switchMap(([isIdle, piper]) =>
      rxjs.iif(
        () => isIdle,
        rxjs.timer(queryString.get("autoclose") == "long" || piper ? 15*60*1000 : 5*60*1000),
        rxjs.EMPTY
      )
    )
  ).subscribe(closePlayer)
}


var messageHandlers = {
  playText: playText,
  playTab: playTab,
  stop: stop,
  pause: pause,
  resume: resume,
  getPlaybackState: getPlaybackState,
  forward: forward,
  rewind: rewind,
  seek: seek,
  close: closePlayer,
  shouldPlaySilence: shouldPlaySilence.bind({}),
  startPairing: () => phoneTtsEngine.startPairing(),
  isPaired: () => phoneTtsEngine.isPaired(),
  managePiperVoices,
  getLastUrl: () => lastUrlPromise,
  seekToOrigText: async function(origTextIndex) {
    if (!activeDoc) return;
    var speech = await activeDoc.getActiveSpeech();
    if (speech && speech.seekToOrigText) speech.seekToOrigText(origTextIndex);
  },
}

registerMessageListener("player", messageHandlers)

if (queryString.has("opener")) {
  brapi.runtime.sendMessage({dest: queryString.get("opener"), method: "playerCheckIn"})
    .catch(console.error)
} else {
  bgPageInvoke("playerCheckIn")
    .catch(console.error)
}

document.addEventListener("DOMContentLoaded", initialize)



async function initialize() {
  setI18nText()

  $("#hidethistab-link")
    .toggle(canUseEmbeddedPlayer() && !(await getSettings()).useEmbeddedPlayer)
    .click(function() {
      $("#dialog-backdrop, #hidethistab-dialog").show()
    })

  $("#hidethistab-dialog .btn, #hidethistab-dialog .close")
    .click(function(event) {
      $("#dialog-backdrop, #hidethistab-dialog").hide()
      if ($(event.target).is(".btn-ok")) {
        updateSettings({useEmbeddedPlayer: true})
          .then(() => window.close())
          .catch(console.error)
      }
    })
}

function playText(text, opts) {
  opts = opts || {}
  playbackError = null
  if (!activeDoc) {
    openDoc(new SimpleSource(text.split(/(?:\r?\n){2,}/), {lang: opts.lang}), function(err) {
      if (err) playbackError = err
    })
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function playTab() {
  playbackError = null
  if (!activeDoc) {
    openDoc(new TabSource(), function(err) {
      if (err) playbackError = err
    })
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function stop() {
  if (activeDoc) {
    activeDoc.stop();
    closeDoc();
  }
  return true;
}

function pause() {
  if (activeDoc) return activeDoc.pause();
  else return Promise.resolve();
}

function resume() {
  if (activeDoc) return activeDoc.play()
  else return Promise.resolve()
}

function getPlaybackState() {
  if (activeDoc) {
    return Promise.all([activeDoc.getState(), activeDoc.getActiveSpeech()])
      .then(function(results) {
        return {
          state: results[0],
          speechInfo: results[1] && results[1].getInfo(),
          playbackError: errorToJson(playbackError),
        }
      })
      .finally(() => {
        playbackError = null
      })
  }
  else {
    return {
      state: "STOPPED",
      playbackError: errorToJson(playbackError),
    }
  }
}

function openDoc(source, onEnd) {
  activeDoc = new Doc(source, function(err) {
    handleError(err);
    closeDoc();
    if (typeof onEnd == "function") onEnd(err);
  })
  idleSubject.next(false)
  lastUrlPromise = Promise.resolve(source.getUri())
}

function closeDoc() {
  if (activeDoc) {
    activeDoc.close();
    activeDoc = null;
    idleSubject.next(true)
    sendHighlightToContent("clearHighlight", [])
    lastHighlightedIndex = null
  }
}

var lastHighlightedIndex = null;

setInterval(async function() {
  try {
    if (!activeDoc) return;
    var settings = await brapi.storage.local.get("showHighlighting");
    if (Number(settings.showHighlighting) != 3) return;
    var speech = await activeDoc.getActiveSpeech();
    if (!speech) return;
    var info = speech.getInfo();
    var origIdx = info.position.originalTextIndex;
    if (origIdx != null && origIdx !== lastHighlightedIndex) {
      lastHighlightedIndex = origIdx;
      sendHighlightToContent("highlightBlock", [origIdx]);
    }
  } catch(e) {}
}, 500);

async function sendHighlightToContent(method, args) {
  try {
    var data = await brapi.storage.local.get("sourceUri");
    if (!data.sourceUri || !data.sourceUri.startsWith("contentscript:")) return;
    var tabId = Number(data.sourceUri.substr(14));
    await brapi.tabs.sendMessage(tabId, {dest: "contentScript", method: method, args: args});
  } catch(e) {}
}

function forward() {
  if (activeDoc) return activeDoc.forward();
  else return Promise.reject(new Error("Can't forward, not active"));
}

function rewind() {
  if (activeDoc) return activeDoc.rewind();
  else return Promise.reject(new Error("Can't rewind, not active"));
}

function seek(n) {
  if (activeDoc) return activeDoc.seek(n);
  else return Promise.reject(new Error("Can't seek, not active"));
}

function closePlayer() {
  if (top == self) window.close()
  else location.href = "about:blank"
}

function handleError(err) {
  if (err) {
    var code = /^{/.test(err.message) ? JSON.parse(err.message).code : err.message;
    reportError(err);
  }
}

function reportError(err) {
  if (err && err.stack) {
    var details = err.stack;
    if (!details.startsWith(err.name)) details = err.name + ": " + err.message + "\n" + details;
    console.error(details)
  }
}

function playAudio(urlPromise, options, playbackState$) {
  return playAudioHere(requestAudioPlaybackPermission().then(() => urlPromise), options, playbackState$)
}

// Runs once per player tab. Firefox's autoplay blocking ("Block Audio and Video",
// or audible autoplay blocked) rejects play() with NotAllowedError until the page
// gets a user gesture — then the dialog waits for a click on "Allow", which counts
// as one and unblocks every later play() in this tab. A failure isn't cached, so
// the next read asks again.
var requestAudioPlaybackPermission = (function() {
  let granted = null
  return () => granted || (granted = request().catch(err => { granted = null; throw err }))

  async function request() {
    const thisTab = await brapi.tabs.getCurrent()
    const prevTab = await brapi.tabs.query({windowId: thisTab.windowId, active: true}).then(tabs => tabs[0])
    await brapi.tabs.update(thisTab.id, {active: true})
    const dialog = $("#dialog-backdrop, #audio-playback-permission-dialog").show()
    const playSilence = () => new Audio(brapi.runtime.getURL("sound/silence.mp3")).play()
    try {
      await playSilence()
    }
    catch (err) {
      if (!err || err.name != "NotAllowedError") { dialog.hide(); throw err }
      await new Promise((fulfill, reject) => {
        $("#audio-playback-permission-dialog .btn-primary").off("click").one("click", () => playSilence().then(fulfill, reject))
        $("#audio-playback-permission-dialog .close").off("click").one("click", () => reject(new Error("Audio playback blocked by the browser's autoplay setting")))
      })
      .finally(() => dialog.hide())
    }
    dialog.hide()
    if (prevTab) await brapi.tabs.update(prevTab.id, {active: true})
  }
})()

async function shouldPlaySilence(providerId) {
  const should = await getPlaybackState().then(x => x.state == "PLAYING")
  const now = Date.now()
  if (providerId == this.providerId) {
    this.nextExpectedCheckIn = now + (now - this.lastCheckIn)
    this.lastCheckIn = now
    return should
  }
  else {
    if (now < this.nextExpectedCheckIn) {
      return false
    }
    else {
      this.providerId = providerId
      this.lastCheckIn = now
      return should
    }
  }
}

function managePiperVoices() {
  if (isEmbedded) {
    return "POPOUT"
  }
  else {
    rxjs.firstValueFrom(piperObservable)
      .catch(console.error)
    brapi.tabs.getCurrent()
      .then(tab => Promise.all([
        brapi.windows.update(tab.windowId, {focused: true}),
        brapi.tabs.update(tab.id, {active: true})
      ]))
      .catch(console.error)
    return "OK"
  }
}

function createPiperFrame() {
  const f = document.createElement("iframe")
  f.id = "piper-frame"
  f.src = "https://piper.ttstool.com/"
  f.allow = "cross-origin-isolated"
  f.style.position = "absolute"
  f.style.left =
  f.style.top = "0"
  f.style.width =
  f.style.height = "100%"
  f.style.borderWidth = "0"
  document.body.appendChild(f)
}

function raisePiperFrame() {
  const maxZ = $('iframe').get().reduce((max, f) => Math.max(max, Number(f.style.zIndex) || 0), 0)
  $('#piper-frame').css('z-index', maxZ + 1)
}


function createFasttextFrame() {
  const f = document.createElement("iframe")
  f.id = "fasttext-frame"
  f.src = "https://ttstool.com/fasttext/index.html"
  f.allow = "cross-origin-isolated"
  f.style.display = "none"
  document.body.appendChild(f)
}
