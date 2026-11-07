
brapi.runtime.onInstalled.addListener(function() {
  installContentScripts()
  installContextMenus()
})

installContextMenus()

/**
 * IPC handlers
 */
var handlers = {
  playText: playText,
  playTab: playTab,
  reloadAndPlayTab: reloadAndPlayTab,
  stop: stop,
  pause: pause,
  resume: resume,
  getPlaybackState: getPlaybackState,
  forward: forward,
  rewind: rewind,
  seek: seek,
  authWavenet: authWavenet,
  managePiperVoices,
}



registerMessageListener("serviceWorker", handlers)


/**
 * Installers
 */
async function installContentScripts() {
  const scripts = [
    {
      matches: ["https://docs.google.com/document/*"],
      id: "google-docs",
      js: ["js/page/google-doc.js"],
      runAt: "document_start",
      world: "MAIN"
    },
  ]
  const registeredIds = await brapi.scripting.getRegisteredContentScripts({ids: scripts.map(x => x.id)})
    .then(scripts => scripts.map(x => x.id))
    .catch(err => {
      console.error(err)
      return []
    })
  if (registeredIds.length) {
    console.info("Already registered content scripts", registeredIds)
  }
  const scriptsToRegister = scripts.filter(script => !registeredIds.includes(script.id))
  for (const script of scriptsToRegister) {
    await brapi.scripting.registerContentScripts([script])
      .then(() => console.info("Successfully registered content script", script.id))
      .catch(err => console.error("Failed to register content script", script.id, err))
  }
}

function installContextMenus() {
  if (!brapi.contextMenus) return
  brapi.contextMenus.create({
    id: "read-selection",
    title: brapi.i18n.getMessage("context_read_selection"),
    contexts: ["selection"]
  }, () => { brapi.runtime.lastError })
  brapi.contextMenus.create({
    id: "read-from-here",
    title: brapi.i18n.getMessage("context_read_from_here"),
    contexts: ["page", "selection", "link"]
  }, () => { brapi.runtime.lastError })
  brapi.contextMenus.create({
    id: "open-settings",
    title: "Open settings",
    contexts: ["action"]
  }, () => { brapi.runtime.lastError })
}


/**
 * Context menu handlers
 */
if (brapi.contextMenus)
brapi.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.menuItemId == "read-selection")
    Promise.resolve()
      .then(function() {
        if (tab && tab.id != -1) return detectTabLanguage(tab.id)
        else return undefined
      })
      .then(function(lang) {
        return playText(info.selectionText, {lang: lang})
      })
      .catch(handleHeadlessError)
  if (info.menuItemId == "read-from-here")
    readFromHere(info, tab)
      .catch(handleHeadlessError)
  if (info.menuItemId == "open-settings")
    brapi.tabs.create({url: brapi.runtime.getURL("options.html")})
})


/**
 * Shortcut keys handlers
 */
if (brapi.commands)
brapi.commands.onCommand.addListener(function(command) {
  if (command == "play" || command == "pause") {
    getPlaybackState()
      .then(function(stateInfo) {
        switch (stateInfo.state) {
          case "PLAYING": return command == "pause" ? pause() : stop()
          case "PAUSED": return resume()
          case "STOPPED": return playTab()
        }
      })
      .catch(handleHeadlessError)
  }
  else if (command == "stop") {
    stop()
      .catch(handleHeadlessError)
  }
  else if (command == "forward") {
    forward()
      .catch(handleHeadlessError)
  }
  else if (command == "rewind") {
    rewind()
      .catch(handleHeadlessError)
  }
  else if (command == "rate-up" || command == "rate-down") {
    adjustRate(command == "rate-up" ? 0.1 : -0.1)
      .catch(handleHeadlessError)
  }
})


/**
 * Listener for external calls
 */
brapi.runtime.onMessageExternal.addListener(
  (request, sender) => {
    if (request.method == "play" && typeof request.text == "string") {
      playText(request.text)
        .catch(handleHeadlessError)
    }
    else if (request.method == "pause") {
      pause()
        .catch(handleHeadlessError)
    }
    else if (request.method == "stop") {
      stop()
        .catch(handleHeadlessError)
    }
    else if (request.method == "resume") {
      resume()
        .catch(handleHeadlessError)
    }
    else {
      handleHeadlessError(new Error("Bad method call"))
    }
  })



/**
 * METHODS
 */
var currentTask = {
  task: null,
  isActive() {
    return this.task && this.task.isActive
  },
  begin() {
    if (this.task) this.task.cancel()
    return this.task = {
      isActive: true,
      cancel() {
        this.isActive = false
      },
      end() {
        if (!this.isActive) throw new Error("Canceled")
        this.isActive = false
      }
    }
  },
  cancel() {
    if (this.task) {
      this.task.cancel()
      this.task = null
    }
  }
}

async function playText(text, opts) {
  const hasPlayer = await stop().then(res => res == true, err => false)
  if (!hasPlayer) await injectPlayer(await getActiveTab())
  await sendToPlayer({method: "playText", args: [text, opts]})
}

async function readFromHere(info, tab) {
  // The seek target must live in the frame html-doc reads (the top frame).
  let marked = false
  if (tab && tab.id != -1 && !info.frameId) {
    const target = {tabId: tab.id}
    try {
      await brapi.scripting.executeScript({target, files: ["js/sentence-splitter.js"]})
      const [res] = await brapi.scripting.executeScript({target, func: markReadFromHere, args: [info.targetElementId != null ? info.targetElementId : null]})
      marked = !!(res && res.result)
    }
    catch (err) {
      // not injectable (extension page, PDF viewer, blocked site): playTab reports it properly
      console.warn(err)
    }
  }
  await playTab(tab && tab.id != -1 ? tab.id : undefined, marked ? {fromHere: true} : undefined)
}

// Runs in the page: turn the selection start (or the right-clicked element)
// into a seek target for html-doc's parse().
function markReadFromHere(targetElementId) {
  const sel = window.getSelection()
  let el = null, node = null, offset = 0
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const range = sel.getRangeAt(0)
    node = range.startContainer
    offset = range.startOffset
    el = node.nodeType == 1 ? node : node.parentElement
  }
  else if (targetElementId != null && typeof browser != "undefined" && browser.menus && browser.menus.getTargetElement) {
    el = browser.menus.getTargetElement(targetElementId)
  }
  if (!el) return false
  let block = el
  while (block.parentElement && block !== document.body && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement
  // Sentence at the selection start, else the block's first sentence: html-doc
  // may treat a whole <article> as one block, so the element alone isn't enough.
  let at = 0
  if (node) {
    const pre = document.createRange()
    pre.selectNodeContents(block)
    pre.setEnd(node, offset)
    at = pre.toString().length
    // a live selection would make content.js read only the selection
    sel.removeAllRanges()
  }
  let sentenceText = null, occurrence = 0
  if (typeof raSentenceSplitter != "undefined") {
    const norm = s => s.text.replace(/\s+/g, " ").trim()
    const sents = raSentenceSplitter.splitWithOffsets(block.textContent)
    const i = sents.findIndex(s => s.end > at)
    if (i >= 0) {
      sentenceText = norm(sents[i])
      // same sentence earlier in the block (a refrain): tell html-doc which one
      occurrence = sents.slice(0, i).filter(s => norm(s) == sentenceText).length
    }
  }
  window.__raSeekTarget = {el: block, sentenceText, occurrence}
  return true
}

// Runs in the page: resume at the saved sentence unless another seek target is
// pending; html-doc calls __raOnResumed once it found the sentence.
function markResumePosition(text, labels) {
  if (window.__raSeekTarget || typeof readAloudDoc == "undefined" || !readAloudDoc.canSeek) return false
  // a selection is read on its own (content.js), not the page
  if (String(window.getSelection() || "").trim()) return false
  window.__raSeekTarget = {el: null, sentenceText: text, resume: true}
  window.__raOnResumed = function() {
    const old = document.getElementById("ra-resume-toast")
    if (old) old.remove()
    const host = document.createElement("div")
    host.id = "ra-resume-toast"
    // bottom 76px: clears the in-page control bar (js/control-bar.js, 16px + 48px)
    host.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;"
    const root = host.attachShadow({mode: "closed"})
    root.innerHTML = '<style>div{font:14px/1.4 system-ui,sans-serif;background:#323232;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;gap:14px;align-items:center}'
      + 'button{font:inherit;font-weight:600;background:none;border:0;color:#8ab4f8;cursor:pointer;padding:0}</style><div><span></span><button type="button"></button></div>'
    root.querySelector("span").textContent = labels.resumed
    const button = root.querySelector("button")
    button.textContent = labels.fromStart
    button.addEventListener("click", function() {
      host.remove()
      const api = typeof browser != "undefined" ? browser : chrome
      api.runtime.sendMessage({dest: "serviceWorker", method: "playTab", args: [null, {fromStart: true}]})
    })
    document.documentElement.appendChild(host)
    setTimeout(() => host.remove(), 8000)
  }
  return true
}

async function applyResumePosition(tab) {
  const pos = await getReadPosition(tab.url)
  if (!pos) return
  await brapi.scripting.executeScript({
    target: {tabId: tab.id},
    func: markResumePosition,
    args: [pos.text, {
      resumed: brapi.i18n.getMessage("resume_toast"),
      fromStart: brapi.i18n.getMessage("resume_from_start"),
    }]
  })
}

async function playTab(tabId, opts) {
  const tab = tabId ? await getTab(tabId) : await getActiveTab()
  if (!tab) throw new Error(JSON.stringify({code: "error_page_unreadable"}))

  const task = currentTask.begin()
  try {
    const handler = contentHandlers.find(h => h.match(tab.url || "", tab.title))
    if (handler.validate) await handler.validate(tab)
    if (handler.getSourceUri) {
      await brapi.storage.local.set({"sourceUri": handler.getSourceUri(tab)})
    }
    else {
      const frameId = handler.getFrameId && await getAllFrames(tab.id).then(frames => handler.getFrameId(frames))
      if (!await contentScriptAlreadyInjected(tab, frameId)) await injectContentScript(tab, frameId, handler.extraScripts)
      await brapi.storage.local.set({"sourceUri": "contentscript:" + tab.id})
      if (!frameId && !(opts && (opts.fromHere || opts.fromStart))) await applyResumePosition(tab).catch(console.error)
    }
  }
  finally {
    task.end()
  }

  const hasPlayer = await stop().then(res => res == true, err => false)
  // after stop(): the player can't write the old position back anymore
  if (opts && opts.fromStart) await clearReadPosition(tab.url)
  if (!hasPlayer) await injectPlayer(tab)
  await sendToPlayer({method: "playTab"})
}

async function reloadAndPlayTab(tabId) {
  const tab = tabId ? await getTab(tabId) : await getActiveTab()

  const task = currentTask.begin()
  try {
    const tabLoadComplete = new Promise(fulfill => {
      function listener(changeTabId, changeInfo) {
        if (changeTabId == tab.id && changeInfo.status == "complete") {
          brapi.tabs.onUpdated.removeListener(listener)
          fulfill()
        }
      }
      brapi.tabs.onUpdated.addListener(listener)
    })
    await brapi.tabs.reload(tab.id)
    await tabLoadComplete
  }
  finally {
    task.end()
  }

  await playTab(tab.id)
}

function stop() {
  currentTask.cancel()
  return sendToPlayer({method: "stop"})
}

function pause() {
  return sendToPlayer({method: "pause"})
}

function resume() {
  return sendToPlayer({method: "resume"})
}

// opts.peek: leave a pending playbackError for the popup to report
async function getPlaybackState(opts) {
  if (currentTask.isActive()) return {state: "LOADING"}
  try {
    return await sendToPlayer({method: "getPlaybackState", args: opts ? [opts] : undefined}) || {state: "STOPPED"}
  }
  catch (err) {
    return {state: "STOPPED"}
  }
}

function forward() {
  return sendToPlayer({method: "forward"})
}

function rewind() {
  return sendToPlayer({method: "rewind"})
}

function seek(n) {
  return sendToPlayer({method: "seek", args: [n]})
}



async function adjustRate(delta) {
  const {voiceName} = await getSettings(["voiceName"])
  const key = "rate" + (voiceName || "")
  const {[key]: current} = await getSettings([key])
  const rate = Math.round(((current || defaults.rate) + delta) * 1000) / 1000
  await updateSettings({[key]: Math.min(10, Math.max(0.1, rate))})
}

function handleHeadlessError(err) {
  console.error(err)
  //TODO: let user knows somehow
}

function authWavenet() {
  createTab("https://cloud.google.com/text-to-speech/#put-text-to-speech-into-action", true)
    .then(function(tab) {
      addRequestListener();
      brapi.tabs.onRemoved.addListener(onTabRemoved);
      return showInstructions();

      function addRequestListener() {
        brapi.webRequest.onBeforeRequest.addListener(onRequest, {
          urls: ["https://cxl-services.appspot.com/proxy*"],
          tabId: tab.id
        })
      }
      function onTabRemoved(tabId) {
        if (tabId == tab.id) {
          brapi.tabs.onRemoved.removeListener(onTabRemoved);
          brapi.webRequest.onBeforeRequest.removeListener(onRequest);
        }
      }
      function onRequest(details) {
        var parser = new URL(details.url);
        var qs = parser.search ? parseQueryString(parser.search) : {};
        if (qs.token) {
          updateSettings({gcpToken: qs.token});
          showSuccess();
        }
      }
      function showInstructions() {
        return brapi.scripting.executeScript({
          target: {tabId: tab.id},
          func: function() {
            var elem = document.createElement('DIV')
            elem.id = 'ra-notice'
            elem.style.position = 'fixed'
            elem.style.top = '0'
            elem.style.left = '0'
            elem.style.right = '0'
            elem.style.backgroundColor = 'yellow'
            elem.style.padding = '20px'
            elem.style.fontSize = 'larger'
            elem.style.zIndex = 999000
            elem.style.textAlign = 'center'
            elem.innerHTML = 'Please click the blue SPEAK-IT button, then check the I-AM-NOT-A-ROBOT checkbox.'
            document.body.appendChild(elem)
          }
        })
      }
      function showSuccess() {
        return brapi.scripting.executeScript({
          target: {tabId: tab.id},
          func: function() {
            var elem = document.getElementById('ra-notice')
            elem.style.backgroundColor = '#0d0'
            elem.innerHTML = 'Successful, you can now use Google Wavenet voices. You may close this tab.'
          }
        })
      }
    })
}

// PDFs are rendered by a viewer hosted on Ken's server (assets.lsdsoftware.com):
// the PDF content is handed to that origin. Declared as optional
// data_collection "websiteContent" — ask once, before the first PDF.
async function pdfConsentPerms() {
  const all = await brapi.permissions.getAll()
  if (!all.data_collection) return null   // Firefox without built-in data consent (<140)
  return all.data_collection.includes("websiteContent") ? null : {data_collection: ["websiteContent"]}
}

async function openPdfViewer(tabId, pdfUrl) {
  const origins = ["http://*/", "https://*/"]
  const perms = Object.assign(
    await brapi.permissions.contains({origins}) ? {} : {origins},
    await pdfConsentPerms()
  )
  if (Object.keys(perms).length) {
    throw new Error(JSON.stringify({code: "error_add_permissions", perms: perms}))
  }
  await setTabUrl(tabId, brapi.runtime.getURL("pdf-viewer.html?url=" + encodeURIComponent(pdfUrl)))
  await new Promise(f => handlers.pdfViewerCheckIn = f)
}

async function managePiperVoices() {
  const result = await sendToPlayer({method: "managePiperVoices"}).catch(err => false)
  if (result != "OK") {
    if (result == "POPOUT") await sendToPlayer({method: "close"})
    await injectPlayer()
    await sendToPlayer({method: "managePiperVoices"})
  }
}

async function contentScriptAlreadyInjected(tab, frameId) {
  const items = await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    func: function() {
      return typeof brapi != "undefined"
    }
  })
  return items[0].result == true
}

async function injectContentScript(tab, frameId, extraScripts) {
  await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    files: [
      "js/rxjs.umd.min.js",
      "js/jquery-3.7.1.min.js",
      "js/defaults.js",
      "js/messaging.js",
      "js/sentence-splitter.js",
      "js/content.js",
      "js/control-bar.js",
    ]
  })
  const files = extraScripts || await brapi.tabs.sendMessage(tab.id, {dest: "contentScript", method: "getRequireJs"})
  if (files.includes("js/content/pdf-doc.js")) {
    const perms = await pdfConsentPerms()
    // reload: content.js is already injected, so a plain retry would skip pdf-doc.js
    if (perms) throw new Error(JSON.stringify({code: "error_add_permissions", perms: perms, reload: true}))
  }
  await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    files: files
  })
  console.info("Content handler", files)
}

async function injectPlayer(tab) {
  const settings = await getSettings(["useEmbeddedPlayer", "piperVoices"])
  const promise = new Promise(f => handlers.playerCheckIn = f)
  if (tab && settings.useEmbeddedPlayer
    //don't use embedded player if there are Piper voices installed
    && (settings.piperVoices || []).length == 0
  ) {
    try {
      if (tab.incognito) {
        //https://developer.chrome.com/docs/extensions/mv3/manifest/incognito/
        throw new Error("Incognito tab")
      }
      await brapi.scripting.executeScript({
        target: {tabId: tab.id},
        func: createPlayerFrame
      })
    }
    catch (err) {
      console.warn("Cannot embed player", err)
      await createPlayerTab()
    }
  }
  else {
    await createPlayerTab()
  }
  await promise
}

function createPlayerFrame() {
  const brapi = (typeof chrome != 'undefined') ? chrome : (typeof browser != 'undefined' ? browser : {})
  const frame = document.createElement("iframe")
  frame.src = brapi.runtime.getURL("player.html")
  frame.style.position = "absolute"
  frame.style.height = "0"
  frame.style.borderWidth = "0"
  document.body.appendChild(frame)
}

async function createPlayerTab() {
  const tab = await brapi.tabs.create({
    url: brapi.runtime.getURL("player.html?autoclose"),
    index: 0,
    active: false,
  })
  //Firefox for Android cannot pin tabs
  try { await brapi.tabs.update(tab.id, {pinned: true}) }
  catch (err) { console.warn(err) }
}



async function sendToPlayer(message) {
  message.dest = "player"
  const result = await brapi.runtime.sendMessage(message)
  if (result && result.error) throw result.error
  else return result
}
