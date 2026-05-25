
var readAloudDoc = new function() {
  var self = this;

  this.ignoreTags = "select, textarea, button, label, audio, video, dialog, embed, menu, nav, noframes, noscript, object, script, style, svg, aside, footer, #footer, .no-read-aloud, [aria-hidden=true]";

  this.getCurrentIndex = function() {
    return 0;
  }

  this.getTexts = async function(index) {
    if (index == 0) {
      const math = await getMath()
      try {
        if (math) math.show()
        return parse()
      }
      finally {
        if (math) math.hide()
      }
    }
    else return null;
  }

  this.getSelectedText = async function() {
    const math = await getMath()
    try {
      if (math) math.show()
      return window.getSelection().toString().trim()
    }
    finally {
      if (math) math.hide()
    }
  }



  function parse() {
    //find blocks containing text
    var start = new Date();
    var textBlocks = findTextBlocks(50);
    var countChars = textBlocks.reduce(function(sum, elem) {return sum + getInnerText(elem).length}, 0);
    console.log("Found", textBlocks.length, "blocks", countChars, "chars in", new Date()-start, "ms");

    if (countChars < 1000) {
      textBlocks = findTextBlocks(3);
      var texts = textBlocks.map(getInnerText);
      console.log("Using lower threshold, found", textBlocks.length, "blocks", texts.join("").length, "chars");

      //trim the head and the tail
      var head, tail;
      for (var i=3; i<texts.length && !head; i++) {
        var dist = getGaussian(texts, 0, i);
        if (texts[i].length > dist.mean + 2*dist.stdev) head = i;
      }
      for (var i=texts.length-4; i>=0 && !tail; i--) {
        var dist = getGaussian(texts, i+1, texts.length);
        if (texts[i].length > dist.mean + 2*dist.stdev) tail = i+1;
      }
      if (head||tail) {
        textBlocks = textBlocks.slice(head||0, tail);
        console.log("Trimmed", head, tail);
      }
    }

    //mark the elements to be read
    var toRead = [];
    for (var i=0; i<textBlocks.length; i++) {
      toRead.push.apply(toRead, findHeadingsFor(textBlocks[i], textBlocks[i-1]));
      toRead.push(textBlocks[i]);
    }
    $(toRead).addClass("read-aloud");   //for debugging only

    // Block-level seek from hover-overlay click
    var seekTarget = window.__raSeekTarget || null;
    if (seekTarget) window.__raSeekTarget = null;
    if (seekTarget && seekTarget.el) {
      for (var si = 0; si < toRead.length; si++) {
        var te = toRead[si];
        if (te === seekTarget.el || te.contains(seekTarget.el) || seekTarget.el.contains(te)) {
          if (si > 0) toRead = toRead.slice(si);
          break;
        }
      }
    }

    //extract texts and build element mapping for in-page highlighting
    var finalTexts = [];
    self._highlightEntries = [];
    for (var i = 0; i < toRead.length; i++) {
      var elem = toRead[i];
      var pairs = getTextsWithElems(elem);
      for (var j = 0; j < pairs.length; j++) {
        if (!isNotEmpty(pairs[j].text)) continue;
        self._highlightEntries.push(pairs[j]);
        finalTexts.push(pairs[j].text);
      }
    }

    // Sentence-level seek within extracted texts
    if (seekTarget && seekTarget.sentenceText) {
      var needle = seekTarget.sentenceText;
      var needlePrefix = needle.slice(0, 40);
      for (var ti = 0; ti < finalTexts.length; ti++) {
        var hay = finalTexts[ti];
        var pos = hay.indexOf(needle);
        if (pos < 0) pos = hay.toLowerCase().indexOf(needle.toLowerCase());
        if (pos < 0) pos = hay.indexOf(needlePrefix);
        if (pos < 0) pos = hay.toLowerCase().indexOf(needlePrefix.toLowerCase());
        if (pos >= 0) {
          self._highlightEntries = self._highlightEntries.slice(ti);
          finalTexts = finalTexts.slice(ti);
          if (pos > 0) finalTexts[0] = finalTexts[0].slice(pos);
          break;
        }
      }
    }

    return finalTexts;
  }

  function findTextBlocks(threshold) {
    var skipTags = "h1, h2, h3, h4, h5, h6, p, a[href], " + self.ignoreTags;
    var isTextNode = function(node) {
      return node.nodeType == 3 && node.nodeValue.trim().length >= 3;
    };
    var isParagraph = function(node) {
      return node.nodeType == 1 && $(node).is("p:visible") && getInnerText(node).length >= threshold;
    };
    var hasTextNodes = function(elem) {
      return someChildNodes(elem, isTextNode) && getInnerText(elem).length >= threshold;
    };
    var hasParagraphs = function(elem) {
      return someChildNodes(elem, isParagraph);
    };
    // Catch span-only paragraphs (Draft.js, rich text editors) where text is split across
    // sibling <span> runs — each span alone may be below the threshold but together they form
    // a paragraph. Only applies when there are no block-level children.
    var blockTags = "div,section,article,main,header,footer,p,ul,ol,dl,table,blockquote,figure,aside,form";
    var hasInlineText = function(elem) {
      if (getInnerText(elem).length < threshold) return false;
      var blockChildren = $(elem).children(blockTags).get();
      if (blockChildren.length === 0) return true;
      // Also match if all block children are link-only wrappers (e.g. Draft.js inline link divs)
      return blockChildren.every(function(child) {
        return $(child).find("a[href]").length > 0 && $(child).children(":not(a[href])").length === 0;
      });
    };
    var containsTextBlocks = function(elem) {
      var childElems = $(elem).children(":not(" + skipTags + ")").get();
      return childElems.some(hasTextNodes) || childElems.some(hasParagraphs) || childElems.some(containsTextBlocks);
    };
    var addBlock = function(elem, multi) {
      if (multi) $(elem).data("read-aloud-multi-block", true);
      textBlocks.push(elem);
    };
    var walk = function() {
      if ($(this).is("frame, iframe")) try {walk.call(this.contentDocument.body)} catch(err) {}
      else if ($(this).is("dl")) addBlock(this);
      else if ($(this).is("ol, ul")) {
        var items = $(this).children().get();
        if (items.some(hasTextNodes)) addBlock(this);
        else if (items.some(hasParagraphs)) addBlock(this, true);
        else if (items.some(containsTextBlocks)) addBlock(this, true);
      }
      else if ($(this).is("tbody")) {
        var rows = $(this).children();
        if (rows.length > 3 || rows.eq(0).children().length > 3) {
          if (rows.get().some(containsTextBlocks)) addBlock(this, true);
        }
        else rows.each(walk);
      }
      else {
        if (hasTextNodes(this)) addBlock(this);
        else if (hasParagraphs(this)) addBlock(this, true);
        else if (hasInlineText(this)) addBlock(this);
        else $(this).add(this.shadowRoot).children(":not(" + skipTags + ")").each(walk);
      }
    };
    var textBlocks = [];
    walk.call(document.body);
    return textBlocks.filter(function(elem) {
      return $(elem).is(":visible") && $(elem).offset().left >= 0;
    })
  }

  function getGaussian(texts, start, end) {
    if (start == undefined) start = 0;
    if (end == undefined) end = texts.length;
    var sum = 0;
    for (var i=start; i<end; i++) sum += texts[i].length;
    var mean = sum / (end-start);
    var variance = 0;
    for (var i=start; i<end; i++) variance += (texts[i].length-mean)*(texts[i].length-mean);
    return {mean: mean, stdev: Math.sqrt(variance)};
  }

  function getTexts(elem) {
    return getTextsWithElems(elem).map(function(p) { return p.text });
  }

  function getTextsWithElems(elem) {
    // Guard: don't hide wrappers that contain the majority of the block's text
    // (e.g. newsletter layouts with float:right main-content columns).
    var beforeLen = (elem.innerText||"").trim().length;
    var toHide = $(elem).find(":visible").filter(dontRead).filter(function() {
      return (this.innerText||"").trim().length < beforeLen * 0.5;
    }).hide();
    $(elem).find("ol, ul").addBack("ol, ul").each(addNumbering);
    var blockChildren = $(elem).data("read-aloud-multi-block")
      ? $(elem).children(":visible").get()
      : $(elem).children("p, blockquote, li, h1, h2, h3, h4, h5, h6").filter(":visible").get();
    var pairs;
    if (blockChildren.length) {
      pairs = [];
      blockChildren.forEach(function(child) {
        getText(child).split(paragraphSplitter).forEach(function(text) {
          pairs.push({elem: child, text: text});
        });
      });
    } else {
      pairs = getText(elem).split(paragraphSplitter).map(function(text) {
        return {elem: elem, text: text};
      });
    }
    $(elem).find(".read-aloud-numbering").remove();
    toHide.show();
    return pairs;
  }

  function addNumbering() {
    var children = $(this).children();
    var text = children.length ? getInnerText(children.get(0)) : null;
    if (text && !text.match(/^[(]?(\d|[a-zA-Z][).])/))
      children.each(function(index) {
        $("<span>").addClass("read-aloud-numbering").text((index +1) + ". ").prependTo(this);
      })
  }

  function dontRead() {
    var float = $(this).css("float");
    var position = $(this).css("position");
    return $(this).is(self.ignoreTags) || $(this).is("sup") || float == "right" || position == "fixed";
  }

  function getText(elem) {
    return addMissingPunctuation(elem.innerText).trim();
  }

  function addMissingPunctuation(text) {
    return text.replace(/(\w)(\s*?\r?\n)/g, "$1.$2");
  }

  function findHeadingsFor(block, prevBlock) {
    var result = [];
    var firstInnerElem = $(block).find("h1, h2, h3, h4, h5, h6, p").filter(":visible").get(0);
    var currentLevel = getHeadingLevel(firstInnerElem);
    var node = previousNode(block, true);
    while (node && node != prevBlock) {
      var ignore = $(node).is(self.ignoreTags);
      if (!ignore && node.nodeType == 1 && $(node).is(":visible")) {
        var level = getHeadingLevel(node);
        if (level < currentLevel) {
          result.push(node);
          currentLevel = level;
        }
      }
      node = previousNode(node, ignore);
    }
    return result.reverse();
  }

  function getHeadingLevel(elem) {
    if (!elem) return 100;
    var matches = /^H(\d)$/i.exec(elem.tagName);
    if (matches) return Number(matches[1]);
    var innerText = getInnerText(elem);
    if (innerText.length <= 60 && !$(elem).find('p, div').length) {
      // Short <p> → pseudo-h3 (e.g. Framer/Webflow styled headings)
      if (elem.tagName === 'P') return 3;
      // Short element with bold inline style → pseudo-h4 (e.g. Draft.js bold headings)
      if (/bold|[6-9]\d\d/.test(elem.style.fontWeight)) return 4;
    }
    return 100;
  }

  function previousNode(node, skipChildren) {
    if ($(node).is('body')) return null;
    if (node.nodeType == 1 && !skipChildren && node.lastChild) return node.lastChild;
    if (node.previousSibling) return node.previousSibling;
    if (node.parentNode) return previousNode(node.parentNode, true);
    return null;
  }

  function someChildNodes(elem, test) {
    var child = elem.firstChild;
    while (child) {
      if (test(child)) return true;
      child = child.nextSibling;
    }
    return false;
  }

  this.highlightBlock = function(origTextIndex) {
    if (!self._highlightEntries) return;
    var entry = self._highlightEntries[origTextIndex];
    if (!entry) return;
    if (!document.getElementById("read-aloud-highlight-style")) {
      var style = document.createElement("style");
      style.id = "read-aloud-highlight-style";
      style.textContent = ".read-aloud-highlight { background-color: rgba(66,133,244,0.15) !important; outline: 2px solid rgba(66,133,244,0.5) !important; border-radius: 3px; } read-aloud-hl { background-color: rgba(66,133,244,0.15); outline: 2px solid rgba(66,133,244,0.5); border-radius: 3px; display: inline; }";
      document.head.appendChild(style);
    }
    self.clearHighlight();

    // Check if multiple texts share this element
    var sameElem = self._highlightEntries.filter(function(e) { return e.elem === entry.elem; });
    if (sameElem.length > 1) {
      // Use range-based highlighting: find text within element
      var mark = highlightTextInElement(entry.elem, entry.text);
      if (mark) { scrollToQuarter(mark); return; }
    }
    // Painting a box around <body>/<html> would mark the whole page — happens on
    // legacy HTML (no semantic <p>, all entries map to body). Skip the box and
    // let the SVG playback overlay carry the highlight.
    if (entry.elem === document.body || entry.elem === document.documentElement) return;
    $(entry.elem).addClass("read-aloud-highlight");
    scrollToQuarter(entry.elem);
  }

  this.attachInPageHandlers = function(seekCallback) {
    if (self._inPageHandlersAttached || !self._highlightEntries) return;
    self._inPageHandlersAttached = true;

    // Group entries by element
    var elemGroups = new Map();
    for (var i = 0; i < self._highlightEntries.length; i++) {
      var elem = self._highlightEntries[i].elem;
      if (!elemGroups.has(elem)) elemGroups.set(elem, []);
      elemGroups.get(elem).push({origIdx: i, text: self._highlightEntries[i].text});
    }

    elemGroups.forEach(function(entries, elem) {
      $(elem).css("cursor", "pointer").on("click.readaloud", function(e) {
        e.preventDefault();
        var origIdx;
        if (entries.length === 1) {
          origIdx = entries[0].origIdx;
        } else {
          origIdx = findClickedEntryByTarget(e.target, entries);
          if (origIdx == null) origIdx = findClickedEntry(elem, entries, e.clientX, e.clientY);
        }
        seekCallback(origIdx);
      });
    });
  }

  this.detachInPageHandlers = function() {
    if (!self._inPageHandlersAttached || !self._highlightEntries) return;
    self._inPageHandlersAttached = false;
    var seenElems = new Set();
    for (var i = 0; i < self._highlightEntries.length; i++) {
      var elem = self._highlightEntries[i].elem;
      if (seenElems.has(elem)) continue;
      seenElems.add(elem);
      $(elem).css("cursor", "").off("click.readaloud");
    }
  }

  this.clearHighlight = function() {
    $(".read-aloud-highlight").removeClass("read-aloud-highlight");
    $("read-aloud-hl").each(function() {
      var parent = this.parentNode;
      while (this.firstChild) parent.insertBefore(this.firstChild, this);
      parent.removeChild(this);
      parent.normalize();
    });
  }

  function scrollToQuarter(elem) {
    // Don't scroll if the "block" is the entire page — would jump to top.
    // SVG playback overlay does its own scrollIntoView on the actual sentence.
    if (elem === document.body || elem === document.documentElement) return;
    var rect = elem.getBoundingClientRect();
    window.scrollTo({top: window.scrollY + rect.top - window.innerHeight * 0.25, behavior: "smooth"});
  }

  function buildTextNodeBuffer(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var textNodes = [];
    var skipSel = "sup, " + self.ignoreTags;
    while (walker.nextNode()) {
      var n = walker.currentNode;
      // Skip text inside sup/ignored ancestors — those are excluded from pair texts
      // (hidden during extraction), so including them here would break indexOf().
      if ($(n.parentNode).closest(skipSel).length) continue;
      textNodes.push(n);
    }
    var buf = "", map = [];
    for (var n = 0; n < textNodes.length; n++) {
      // Insert a boundary space between adjacent text nodes — without it, sibling
      // texts like "<h2>Title</h2>Body" become "TitleBody" and the search misses.
      if (n > 0 && buf.length > 0 && buf[buf.length - 1] !== " ") {
        buf += " ";
        map.push({ni: n - 1, off: textNodes[n-1].nodeValue.length});
      }
      var text = textNodes[n].nodeValue;
      for (var c = 0; c < text.length; c++) {
        if (/\s/.test(text[c])) {
          if (buf.length > 0 && buf[buf.length - 1] !== " ") { buf += " "; map.push({ni: n, off: c}); }
        } else { buf += text[c]; map.push({ni: n, off: c}); }
      }
    }
    return {textNodes: textNodes, buf: buf, map: map};
  }

  // Normalize for search: skip "." inserted by addMissingPunctuation (period before
  // whitespace) and collapse multi-whitespace. Returns { text, srcMap } where
  // srcMap[normIdx] = source position in s, so matches can be mapped back.
  function normalizeForSearch(s) {
    var out = '', srcMap = [];
    var lastWasSpace = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '.' && i + 1 < s.length && /\s/.test(s[i+1])) continue;
      if (/\s/.test(c)) {
        if (!lastWasSpace && out.length > 0) { out += ' '; srcMap.push(i); lastWasSpace = true; }
      } else {
        out += c; srcMap.push(i); lastWasSpace = false;
      }
    }
    return { text: out, srcMap: srcMap };
  }

  function findClickedEntryByTarget(target, entries) {
    var node = target;
    while (node && node.nodeType !== 1) node = node.parentNode;
    while (node) {
      var norm = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (norm.length >= 3) {
        for (var e = 0; e < entries.length; e++) {
          var needle = entries[e].text.replace(/\s+/g, " ").trim();
          if (!needle) continue;
          // Only accept if ancestor text is roughly this entry (not a giant container).
          if (norm.length / needle.length > 1.3) continue;
          if (norm === needle || norm.indexOf(needle) === 0 || needle.indexOf(norm) === 0) {
            return entries[e].origIdx;
          }
        }
      }
      node = node.parentNode;
      if (!node || node.nodeType !== 1) break;
    }
    return null;
  }

  function findClickedEntry(container, entries, clientX, clientY) {
    // Get caret position at click point (cross-browser)
    var clickedNode, clickedOffset;
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) { clickedNode = pos.offsetNode; clickedOffset = pos.offset; }
    } else if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(clientX, clientY);
      if (r) { clickedNode = r.startContainer; clickedOffset = r.startOffset; }
    }
    if (!clickedNode) return entries[0].origIdx;

    var tb = buildTextNodeBuffer(container);
    var textNodes = tb.textNodes, buf = tb.buf, map = tb.map;

    // Find click position in normalized buffer
    var clickNodeIdx = textNodes.indexOf(clickedNode);
    if (clickNodeIdx === -1) return entries[0].origIdx;
    var clickBufPos = 0;
    for (var i = 0; i < map.length; i++) {
      if (map[i].ni === clickNodeIdx && map[i].off >= clickedOffset) { clickBufPos = i; break; }
    }

    // Find which entry's text starts at or before the click position
    var best = entries[0];
    var searchFrom = 0;
    for (var e = 0; e < entries.length; e++) {
      var needle = entries[e].text.replace(/\s+/g, " ").trim();
      var idx = buf.indexOf(needle, searchFrom);
      if (idx === -1) continue;
      if (idx <= clickBufPos) best = entries[e];
      else break;
      searchFrom = idx + needle.length;
    }
    return best.origIdx;
  }

  function highlightTextInElement(container, searchText) {
    var tb = buildTextNodeBuffer(container);
    var textNodes = tb.textNodes, buf = tb.buf, map = tb.map;
    if (!textNodes.length) return null;
    var needle = searchText.replace(/\s+/g, " ").trim();

    // Tolerant search: normalize away dots inserted by addMissingPunctuation
    // (period before whitespace) so needle matches buf even when buf lacks those dots.
    var bufView = normalizeForSearch(buf);
    var needleView = normalizeForSearch(needle);
    var nText = needleView.text;
    // Drop optional numbering prefix ("1. ", "1) ", or just "1 " after normalize)
    // that addNumbering may have inserted and later removed.
    var numMatch = nText.match(/^\d+[.)]?\s+/);
    if (numMatch) nText = nText.substring(numMatch[0].length);

    var nIdx = bufView.text.indexOf(nText);
    if (nIdx === -1) {
      // Sibling-text-node boundary spaces can cause end-of-string drift
      // (e.g. "etc." vs "etc ."), so try a short prefix.
      nText = nText.substring(0, 60);
      nIdx = bufView.text.indexOf(nText);
      if (nIdx === -1) return null;
    }

    // Map back from normalized indices to original buf positions
    var idx = bufView.srcMap[nIdx];
    var endIdx = bufView.srcMap[nIdx + nText.length - 1];
    if (idx == null || endIdx == null || endIdx >= map.length) return null;

    var s = map[idx];
    var e = map[endIdx];
    var range = document.createRange();
    range.setStart(textNodes[s.ni], s.off);
    range.setEnd(textNodes[e.ni], e.off + 1);

    try {
      var mark = document.createElement("read-aloud-hl");
      range.surroundContents(mark);
      return mark;
    } catch(err) {
      // surroundContents fails if range crosses element boundaries (e.g. footnotes,
      // <br>-separated lines in legacy <UL> markup). Wrap each text node individually
      // and tolerate per-node failures so partial highlight beats no highlight.
      var firstMark = null;
      for (var i = s.ni; i <= e.ni; i++) {
        var node = textNodes[i];
        if (!node.nodeValue.trim()) continue;
        var r = document.createRange();
        r.setStart(node, i === s.ni ? s.off : 0);
        r.setEnd(node, i === e.ni ? e.off + 1 : node.nodeValue.length);
        var m = document.createElement("read-aloud-hl");
        try { r.surroundContents(m); if (!firstMark) firstMark = m; }
        catch(_) { /* skip this node, continue with others */ }
      }
      return firstMark;
    }
  }
}
