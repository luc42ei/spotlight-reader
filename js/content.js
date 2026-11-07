
(function() {
  registerMessageListener("contentScript", {
    getRequireJs: getRequireJs,
    getDocumentInfo: getInfo,
    getCurrentIndex: getCurrentIndex,
    getTexts: getTexts,
    getItalics: function(index) {
      return readAloudDoc.getItalics ? readAloudDoc.getItalics(index) : null;
    },
    highlightBlock: function(origTextIndex) {
      if (readAloudDoc.highlightBlock) readAloudDoc.highlightBlock(origTextIndex);
    },
    clearHighlight: function() {
      if (readAloudDoc.clearHighlight) readAloudDoc.clearHighlight();
      if (readAloudDoc.detachInPageHandlers) readAloudDoc.detachInPageHandlers();
    }
  })

  function getInfo() {
    return {
      url: location.href,
      title: document.title,
      lang: getLang(),
      canSeek: typeof readAloudDoc != "undefined" && !!readAloudDoc.canSeek,
    }
  }

  function getLang() {
    var lang = document.documentElement.lang || $("html").attr("xml:lang");
    if (lang) lang = lang.split(",",1)[0].replace(/_/g, '-');
    return lang;
  }

  function getRequireJs() {
    if (location.hostname == "docs.google.com") {
      if (/^\/presentation\/d\//.test(location.pathname)) return ["js/content/google-slides.js"];
      else if (/\/document\/d\//.test(location.pathname)) return ["js/content/googleDocsUtil.js", "js/content/google-doc.js"];
      else if ($(".drive-viewer-paginated-scrollable").length) return ["js/content/google-drive-doc.js"];
      else return ["js/content/html-doc.js", "js/content/hover-overlay.js"];
    }
    else if (location.hostname == "drive.google.com") {
      if ($(".drive-viewer-paginated-scrollable").length) return ["js/content/google-drive-doc.js"];
      else return ["js/content/google-drive-preview.js"];
    }
    else if (location.hostname == "onedrive.live.com" && $(".OneUp-pdf--loaded").length) return ["js/content/onedrive-doc.js"];
    else if (/^read\.amazon\./.test(location.hostname)) return ["js/content/kindle-book.js"];
    else if (location.hostname.endsWith(".khanacademy.org")) return ["js/content/khan-academy.js"];
    else if (location.hostname.endsWith("acrobatiq.com")) return ["js/content/html-doc.js", "js/content/acrobatiq.js", "js/content/hover-overlay.js"];
    else if (location.hostname == "digital.wwnorton.com") return ["js/content/html-doc.js", "js/content/wwnorton.js", "js/content/hover-overlay.js"];
    else if (location.hostname == "plus.pearson.com") return ["js/content/html-doc.js", "js/content/pearson.js", "js/content/hover-overlay.js"];
    else if (location.hostname == "www.ixl.com") return ["js/content/ixl.js"];
    else if (location.hostname == "www.webnovel.com" && location.pathname.startsWith("/book/")) return ["js/content/webnovel.js"];
    else if (location.hostname == "archiveofourown.org") return ["js/content/archiveofourown.js"];
    else if (location.hostname == "chat.openai.com") return ["js/content/chatgpt.js"];
    else if (location.pathname.match(/readaloud\.html$/)
      || location.pathname.match(/\.pdf$/)
      || $("embed[type='application/pdf']").length
      || $("iframe[src*='.pdf']").length) return ["js/content/pdf-doc.js"];
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)
        && location.port === "1122"
        && location.protocol === "http:"
        && location.pathname === "/bookshelf/index.html") return  ["js/content/yd-app-web.js"];
    else return ["js/content/html-doc.js", "js/content/hover-overlay.js"];
  }

  async function getCurrentIndex() {
    if (await getSelectedText()) return -100;
    else return readAloudDoc.getCurrentIndex();
  }

  async function getTexts(index, quietly) {
    if (index < 0) {
      if (index == -100) return (await getSelectedText()).split(paragraphSplitter);
      else return null;
    }
    else {
      return Promise.resolve(readAloudDoc.getTexts(index, quietly))
        .then(function(texts) {
          if (texts && Array.isArray(texts)) {
            if (!quietly) console.log(texts.join("\n\n"));
            // Attach in-page click handlers if mode is active
            brapi.storage.local.get("showHighlighting").then(function(s) {
              if (Number(s.showHighlighting) === 3 && readAloudDoc.attachInPageHandlers && !window.__raHoverOverlayActive) {
                readAloudDoc.attachInPageHandlers(function(origTextIndex) {
                  sendToPlayer({method: "seekToOrigText", args: [origTextIndex]}).catch(function(){});
                });
              }
            });
          }
          return texts;
        })
    }
  }

  function getSelectedText() {
    if (readAloudDoc.getSelectedText) return readAloudDoc.getSelectedText()
    return window.getSelection().toString().trim();
  }


  getSettings()
    .then(settings => {
      if (settings.fixBtSilenceGap)
        setInterval(updateSilenceTrack.bind(null, Math.random()), 5000)
    })

  async function updateSilenceTrack(providerId) {
    if (!audioCanPlay()) return;
    const silenceTrack = getSilenceTrack()
    try {
      const should = await sendToPlayer({method: "shouldPlaySilence", args: [providerId]})
      if (should) silenceTrack.start()
      else silenceTrack.stop()
    }
    catch (err) {
      silenceTrack.stop()
    }
  }

  function audioCanPlay() {
    return navigator.userActivation && navigator.userActivation.hasBeenActive
  }

  async function sendToPlayer(message) {
    message.dest = "player"
    let result
    try {
      result = await brapi.runtime.sendMessage(message)
    } catch (err) {
      // service worker restarted (idle timeout) — context is invalidated
      return null
    }
    if (result && result.error) throw result.error
    else return result
  }
})()


//helpers --------------------------

var paragraphSplitter = /(?:\s*\r?\n\s*){2,}/;

function getInnerText(elem) {
  var text = elem.innerText;
  return text ? text.trim() : "";
}

function isNotEmpty(text) {
  return text;
}

function fixParagraphs(texts) {
  var out = [];
  var para = "";
  for (var i=0; i<texts.length; i++) {
    if (!texts[i]) {
      if (para) {
        out.push(para);
        para = "";
      }
      continue;
    }
    if (para) {
      if (/[-\u2013\u2014]$/.test(para)) para = para.substr(0, para.length-1);
      else para += " ";
    }
    para += texts[i].replace(/[-\u2013\u2014]\r?\n/g, "");
    if (texts[i].match(/[.!?:)"'\u2019\u201d]$/)) {
      out.push(para);
      para = "";
    }
  }
  if (para) out.push(para);
  return out;
}

function tryGetTexts(getTexts, millis) {
  return waitMillis(500)
    .then(getTexts)
    .then(function(texts) {
      if (texts && !texts.length && millis-500 > 0) return tryGetTexts(getTexts, millis-500);
      else return texts;
    })
}

function loadPageScript(url) {
  if (!$("head").length) $("<head>").prependTo("html");
  $.ajax({
    dataType: "script",
    cache: true,
    url: url
  });
}

function simulateMouseEvent(element, eventName, coordX, coordY) {
  element.dispatchEvent(new MouseEvent(eventName, {
    view: window,
    bubbles: true,
    cancelable: true,
    clientX: coordX,
    clientY: coordY,
    button: 0
  }));
}

function simulateClick(elementToClick) {
  var box = elementToClick.getBoundingClientRect(),
      coordX = box.left + (box.right - box.left) / 2,
      coordY = box.top + (box.bottom - box.top) / 2;
  simulateMouseEvent (elementToClick, "mousedown", coordX, coordY);
  simulateMouseEvent (elementToClick, "mouseup", coordX, coordY);
  simulateMouseEvent (elementToClick, "click", coordX, coordY);
}

const getMath = (function() {
  let promise = Promise.resolve(null)
  return () => promise = promise.then(math => math || makeMath())
})();

// Speech surrogates for math, computed locally (no page content leaves the
// browser): the author's alttext/aria-label if present, else the MathML token
// text in reading order ("x = 2 + 1").
async function makeMath() {
  const tokensOf = function(mathEl) {
    if (!mathEl) return ""
    const label = mathEl.getAttribute("alttext") || mathEl.getAttribute("aria-label")
    if (label) return label
    return Array.from(mathEl.querySelectorAll("mi, mn, mo, mtext, ms"))
      .filter(t => !t.closest("annotation, annotation-xml"))
      .map(t => t.textContent.trim()).filter(Boolean).join(" ")
  }

  //where the math lives on this page
  const math =
    when(document.querySelector(".MathJax, .MathJax_Preview"), {
      selector: ".MathJax[data-mathml]",
      getText(el) {
        const mathEl = el.querySelector("math")
          || new DOMParser().parseFromString(el.getAttribute("data-mathml"), "text/xml").querySelector("math")
        return el.getAttribute("aria-label") || tokensOf(mathEl)
      },
    })
    .when(() => document.querySelector("math"), {
      selector: "math",
      getText: tokensOf,
    })
    .else(null)

  if (!math) return null
  const elems = $(math.selector).get()
  if (!elems.length) return null

  //create speech surrogates
  try {
    elems.forEach(el => $("<span>").addClass("readaloud-mathml").text(math.getText(el) || "math expression").hide().insertBefore(el))
  }
  catch (err) {
    console.error(err)
    return {
      show() {},
      hide() {}
    }
  }

  //return functions to toggle between mml and speech
  return {
    show() {
      for (const el of elems) el.style.setProperty("display", "none", "important")
      $(".readaloud-mathml").show()
    },
    hide() {
      $(elems).css("display", "")
      $(".readaloud-mathml").hide()
    }
  }
}
