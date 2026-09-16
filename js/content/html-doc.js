
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

  // Italic phrases per extracted text, aligned with the array getTexts()
  // returned for the same index. Must be called after getTexts(), which is what
  // runs parse() and fills _highlightEntries.
  this.getItalics = function(index) {
    if (index != 0 || !self._highlightEntries) return null;
    return self._highlightEntries.map(function(entry) {
      if (!entry.italics || !entry.italics.length) return [];
      // A sentence-level seek slices entry.text; phrases that fell into the cut
      // prefix are no longer in what gets spoken.
      return entry.italics.filter(function(p) { return entry.text.indexOf(p) >= 0 });
    });
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
    searchCursor = {elem: null, pos: 0, idx: -1};
    self._seekSlicePrefix = null;
    self._seekSliceElem = null;
    for (var i = 0; i < toRead.length; i++) {
      var elem = toRead[i];
      var pairs = getTextsWithElems(elem);
      for (var j = 0; j < pairs.length; j++) {
        if (!isNotEmpty(pairs[j].text)) continue;
        self._highlightEntries.push(pairs[j]);
        finalTexts.push(pairs[j].text);
      }
    }
    // Unsliced view for the overlay's occurrence counting: when entries share
    // one element (legacy shared containers), the overlay must count needle
    // occurrences across ALL earlier same-element entries — including those a
    // seek sliced away, since their text is still in the DOM.
    self._highlightEntriesAll = self._highlightEntries;
    self._highlightEntriesOffset = 0;

    // Sentence-level seek within extracted texts. seekTarget.sentenceText comes
    // from textContent (whitespace-collapsed, no added dots), while finalTexts
    // retains original newlines and may have addMissingPunctuation dots. So
    // normalize both sides (collapse whitespace + strip dots-before-whitespace).
    if (seekTarget && seekTarget.sentenceText) {
      var needle = seekTarget.sentenceText;
      var normalizeHaystack = function(s) {
        return s.replace(/\s+/g, ' ').replace(/\.(\s|$)/g, '$1').trim();
      };
      var needleN = normalizeHaystack(needle);
      var haysN = finalTexts.map(normalizeHaystack);
      // One match tier at a time across ALL texts (exact → case-insensitive →
      // 40-char prefix → prefix CI): a weaker tier must not match an earlier
      // paragraph before a stronger tier gets to try a later one — nearly
      // identical refrain sentences can differ only mid-sentence. Within a
      // tier, prefer the entry whose element relates to the clicked block,
      // which disambiguates even fully identical sentences.
      var probes = [
        {s: needleN, ci: false},
        {s: needleN.toLowerCase(), ci: true},
        {s: needleN.slice(0, 40), ci: false},
        {s: needleN.slice(0, 40).toLowerCase(), ci: true},
      ];
      var ti = -1;
      for (var p = 0; p < probes.length && ti < 0; p++) {
        var first = -1;
        for (var i = 0; i < haysN.length; i++) {
          var hay = probes[p].ci ? haysN[i].toLowerCase() : haysN[i];
          if (hay.indexOf(probes[p].s) < 0) continue;
          if (first < 0) first = i;
          var el = seekTarget.el, ee = self._highlightEntries[i].elem;
          if (el && ee && (ee === el || ee.contains(el) || el.contains(ee))) { ti = i; break; }
        }
        if (ti < 0) ti = first;
      }
      // Sentence-level slice WITHIN the matched entry: find the sentence the
      // click landed on (same splitter the TTS chunker uses, so boundaries
      // agree) and cut everything before it. entry.text is mutated in place
      // so chunkStart (speech.js) stays aligned with the sliced text; the cut
      // prefix is remembered so the overlay's occurrence counting (which reads
      // it back from the still-unmodified DOM) doesn't miscount matches that
      // fall inside it.
      if (ti >= 0 && typeof raSentenceSplitter !== 'undefined') {
        var sentSplit = raSentenceSplitter.splitWithOffsets(finalTexts[ti]);
        var sentStart = -1;
        for (var sp = 0; sp < probes.length && sentStart < 0; sp++) {
          for (var si2 = 0; si2 < sentSplit.length; si2++) {
            var sHay = normalizeHaystack(sentSplit[si2].text);
            if (probes[sp].ci) sHay = sHay.toLowerCase();
            if (sHay.indexOf(probes[sp].s) >= 0) { sentStart = sentSplit[si2].start; break; }
          }
        }
        if (sentStart > 0) {
          var prefix = finalTexts[ti].slice(0, sentStart);
          finalTexts[ti] = finalTexts[ti].slice(sentStart);
          self._highlightEntries[ti].text = finalTexts[ti];
          self._seekSlicePrefix = prefix;
          self._seekSliceElem = self._highlightEntries[ti].elem;
        }
      }
      if (ti > 0) {
        self._highlightEntriesOffset = ti;
        self._highlightEntries = self._highlightEntries.slice(ti);
        finalTexts = finalTexts.slice(ti);
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
    $(elem).find("ol").addBack("ol").each(addNumbering);
    var blockChildren = expandLists($(elem).data("read-aloud-multi-block")
      ? $(elem).children(":visible").get()
      : $(elem).children("p, blockquote, li, h1, h2, h3, h4, h5, h6, ul, ol, dl").filter(":visible").get());
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
    refineEntryElems(elem, pairs);
    for (var pi = 0; pi < pairs.length; pi++) pairs[pi].italics = collectItalics(pairs[pi]);
    $(elem).find(".read-aloud-numbering").remove();
    toHide.show();
    return pairs;
  }

  // A list is one child element but many paragraphs: innerText separates its items
  // by a single \n, which paragraphSplitter (blank line) doesn't cut. The whole list
  // then became ONE entry — every chunk of it mapped to the same originalTextIndex,
  // so the blue box stayed parked on the first bullet while the reading ran on, and
  // the amber overlay stopped scrolling because its anchor no longer matched the
  // sentence (common on job ads and feature lists). Read the items as siblings.
  function expandLists(children) {
    var out = [];
    children.forEach(function(child) {
      var items = $(child).is("ul, ol, dl") ? $(child).children("li, dd, dt").filter(":visible").get() : [];
      if (items.length) out = out.concat(expandLists(items));
      else out.push(child);
    });
    return out;
  }

  var PARA_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, pre, td";

  // Modern pages nest the article in wrapper <div>s, so getText() runs on one big
  // container and every extracted paragraph maps to that same element. The blue box
  // then has to locate the paragraph by searching the whole article's text, which
  // picks the FIRST occurrence — and a table of contents repeats every heading, so
  // the box lands at the top of the page and drags the view with it. Resolve each
  // entry to the leaf block that actually holds its text instead, walking forward
  // through the document so repeated text resolves to the passage being read.
  // Texts themselves are untouched — only entry.elem gets sharper.
  function refineEntryElems(container, pairs) {
    if (!pairs.length) return;
    // Leaf = a paragraph-ish element with no paragraph-ish descendant (so a
    // <blockquote> wrapping <p>s yields the <p>s). Derived by marking ancestors
    // instead of a nested find() per candidate, which keeps this one pass.
    var cand = $(container).find(PARA_SELECTOR).filter(":visible").get();
    var candSet = new Set(cand), inner = new Set();
    for (var k = 0; k < cand.length; k++) {
      for (var p = cand[k].parentElement; p && p !== container; p = p.parentElement) {
        if (candSet.has(p)) { inner.add(p); break }
      }
    }
    var leaves = cand.filter(function(el) { return !inner.has(el) });
    if (!leaves.length) return;
    var norm = function(s) { return (s || "").replace(/\s+/g, " ").replace(/\.(\s|$)/g, "$1").trim() };
    var leafTexts = leaves.map(function(el) { return norm(el.innerText) });
    var cursor = 0;
    for (var i = 0; i < pairs.length; i++) {
      var needle = norm(pairs[i].text);
      // Too short to identify a block (list markers like "2.", "(a)") — a bare digit
      // would match anywhere. Leave those on the original element.
      if (needle.length < 4) continue;
      var probe = needle.slice(0, 40);
      for (var j = cursor; j < leaves.length; j++) {
        // An entry can also span several leaves (a heading glued to the following
        // list marker by innerText), so a leaf that starts the entry counts too.
        if (leafTexts[j].indexOf(probe) < 0
            && !(leafTexts[j].length >= 4 && needle.indexOf(leafTexts[j]) === 0)) continue;
        // Legacy pages put a whole essay into one <p> (paulgraham.com). Outlining
        // that leaf would paint a page-tall box, so leave those entries on the
        // original element — highlightTextInElement's range fallback handles them.
        if (leafTexts[j].length > needle.length * 4 + 200) break;
        pairs[i].elem = leaves[j];
        // One leaf can hold several entries (a <p> whose <br><br> split it into
        // paragraphs), so only advance past it once its text is used up.
        cursor = leafTexts[j].length > needle.length + 5 ? j : j + 1;
        break;
      }
    }
  }

  // Italic phrases within an entry, for engines that can emphasize them (see
  // GoogleWavenetTtsEngine). Collected as plain substrings, not offsets: they
  // then survive preprocess(), chunking and the appended sentence dot in
  // speech.js, and entry.text stays byte-identical — the highlight pipeline
  // matches on exact text, so mutating it here would break the blue box.
  // <span> is in the selector because plenty of sites italicize through a CSS
  // class rather than a tag; the computed-style check below does the filtering.
  var ITALIC_SELECTOR = "i, em, cite, var, dfn, span, [style*='italic']";

  function collectItalics(pair) {
    if (!pair.elem || !pair.elem.querySelectorAll || !pair.text) return [];
    var cand = [];
    var nodes = pair.elem.querySelectorAll(ITALIC_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // <em> can be reset to upright by CSS, and [style*=italic] also matches
      // font-family names — trust the computed style, not the markup.
      if (!/^(italic|oblique)/.test(getComputedStyle(el).fontStyle)) continue;
      cand.push(el);
    }
    var set = new Set(cand);
    var result = [];
    for (var i = 0; i < cand.length; i++) {
      // Nested italics: the outermost wins, one <emphasis> per passage.
      var nested = false;
      for (var a = cand[i].parentElement; a && a !== pair.elem; a = a.parentElement)
        if (set.has(a)) { nested = true; break }
      if (nested) continue;
      var phrase = (cand[i].innerText || "").replace(/\s+/g, " ").trim();
      // A whole italic paragraph (pull quote, caption) carries no emphasis, and
      // stressing a long passage sounds wrong — only short inline runs qualify.
      if (phrase.length < 2 || phrase.length > 60) continue;
      if (phrase.split(/\s+/).length > 8) continue;
      if (phrase.length >= pair.text.length * 0.7) continue;
      if (pair.text.indexOf(phrase) < 0) continue;
      result.push(phrase);
    }
    return result;
  }

  function addNumbering() {
    var children = $(this).children();
    var text = children.length ? getInnerText(children.get(0)) : null;
    if (text && !text.match(/^[(]?(\d|[a-zA-Z][).])/)) {
      // Honour the list's own counter (<ol start> / <li value>) — pages that split
      // one logical list into several <ol start="n"> blocks would otherwise all
      // be numbered "1.".
      var counter = Number(this.getAttribute("start")) || 1;
      children.each(function() {
        var value = Number(this.getAttribute("value"));
        if (value) counter = value;
        $("<span>").addClass("read-aloud-numbering").text(counter + ". ").prependTo(this);
        counter++;
      })
    }
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
    // A pure list marker ("2.", "(a)" — inserted by addNumbering) has no location of
    // its own: searching for it lands on a random digit somewhere in the container and
    // drags the view there. Keep the previous box (same guard as the amber overlay).
    if (/^\s*\(?\d{1,3}[).]?\s*$/.test(entry.text) || /^\s*\(?[a-zA-Z][).]\s*$/.test(entry.text)) return;
    if (!document.getElementById("read-aloud-highlight-style")) {
      var style = document.createElement("style");
      style.id = "read-aloud-highlight-style";
      style.textContent = ".read-aloud-highlight { background-color: rgba(66,133,244,0.15) !important; outline: 2px solid rgba(66,133,244,0.5) !important; border-radius: 3px; } read-aloud-hl { background-color: rgba(66,133,244,0.15); outline: 2px solid rgba(66,133,244,0.5); border-radius: 3px; display: inline; }";
      document.head.appendChild(style);
    }
    self.clearHighlight();

    // Painting a box around <body>/<html> would mark the whole page — happens on
    // legacy HTML (no semantic <p>, all entries map to body). Skip the box and
    // let the SVG playback overlay carry the highlight.
    if (entry.elem === document.body || entry.elem === document.documentElement) return;

    // Prefer one box around the whole block: the blue box conveys paragraph-level
    // scroll context, while the amber SVG overlay already marks the active sentence.
    // Range-based sub-highlighting is reserved for non-semantic shared containers
    // (legacy <div>/<td> holding many entries), where outlining the whole element
    // would paint a huge box. A semantic paragraph tag, or an element holding just
    // this one entry, is always outlined whole.
    var sameElem = self._highlightEntries.filter(function(e) { return e.elem === entry.elem; });
    var PARA_TAGS = { P:1, LI:1, BLOCKQUOTE:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, DD:1, DT:1, FIGCAPTION:1, PRE:1 };
    if (sameElem.length === 1 || PARA_TAGS[entry.elem.tagName]) {
      var boxEl = entry.elem;
      // Legacy font-soup: the entry's elem can be an inline element (<font>)
      // covering only part of the visual paragraph (footnote links split it
      // into several fonts). The overlay's synthetic block wrapper
      // [data-ra-block] (present when in-page highlighting is active) spans
      // the whole bare-text run — outline that instead.
      if (!PARA_TAGS[boxEl.tagName] && boxEl.closest) {
        var wrap = boxEl.closest("[data-ra-block]");
        if (wrap) boxEl = wrap;
      }
      $(boxEl).addClass("read-aloud-highlight");
      scrollToQuarter(boxEl);
      return;
    }

    // Non-semantic shared container → scope to this entry's text. Search from the
    // last match onwards (same idea as the overlay's forward cursor): text that
    // repeats earlier on the page — a table of contents holds a copy of every
    // heading — would otherwise match that earlier copy and drag the view up.
    var forward = (searchCursor.elem === entry.elem && origTextIndex >= searchCursor.idx)
      ? searchCursor.pos : 0;
    var found = highlightTextInElement(entry.elem, entry.text, forward);
    if (found) {
      searchCursor = {elem: entry.elem, pos: found.pos, idx: origTextIndex};
      scrollToQuarter(found.el);
      return;
    }
    // Nothing at or after the reading position. Try the whole container, but paint
    // without scrolling: a match before the cursor is more likely a duplicate
    // (heading in a table of contents) than the passage being read.
    found = forward ? highlightTextInElement(entry.elem, entry.text, 0) : null;
    if (found) return;
    // Couldn't scope safely (range crosses element boundaries) → skip the box rather
    // than fragment it; the SVG playback overlay carries the highlight.
  }

  // Reading position of the fallback text search: {elem, pos, idx} — pos is the
  // last match's start offset in the container's normalized search buffer, idx the
  // entry it came from, so a backwards seek resets the search to the top. Keeping
  // the start (not the end) makes re-highlighting the same entry — one entry spans
  // several spoken chunks — land on the same spot every time.
  var searchCursor = {elem: null, pos: 0, idx: -1};

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
    // Already in a comfortable reading position → leave the view alone. Several
    // chunks and several entries can map to one block (a <p> split at <br><br>, a
    // blockquote read paragraph by paragraph, a block taller than the viewport);
    // re-scrolling it to the same offset would yank the view back up while the
    // reader has moved on. The amber sentence overlay does the fine scrolling.
    var targetTop = window.innerHeight * 0.15;
    if (rect.bottom > targetTop && rect.top < window.innerHeight * 0.6) return;
    window.scrollTo({top: window.scrollY + rect.top - targetTop, behavior: "smooth"});
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

  // Returns {el, pos} — the outlined element and the match's start offset in the
  // normalized search buffer (the caller's forward cursor), or null.
  function highlightTextInElement(container, searchText, fromPos) {
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

    var from = fromPos || 0;
    var nIdx = bufView.text.indexOf(nText, from);
    if (nIdx === -1) {
      // Sibling-text-node boundary spaces can cause end-of-string drift
      // (e.g. "etc." vs "etc ."), so try a short prefix.
      nText = nText.substring(0, 60);
      nIdx = bufView.text.indexOf(nText, from);
      if (nIdx === -1) return null;
    }

    // Map the match start back to its source text node.
    var idx = bufView.srcMap[nIdx];
    if (idx == null) return null;
    var s = map[idx];

    // Outline the tightest block element enclosing the match (the actual paragraph),
    // not the matched substring — gives one clean box around the whole paragraph even
    // when entry.elem is a big shared container (e.g. the whole newsletter <table>) and
    // the text node is split by inline <sup>/<a>/<br>. Walking up returns the tightest
    // block, so neighbouring paragraphs aren't included.
    var block = textNodes[s.ni].parentNode;
    while (block && block !== document.body && block !== document.documentElement
        && !BLOCK_TAGS[block.tagName]
        && !(block.hasAttribute && block.hasAttribute("data-ra-block"))) {
      block = block.parentNode;
    }
    // A block that tightly bounds the paragraph → outline it as one box. The size guard
    // rejects big containers (e.g. a <td>/<div> wrapping the whole article).
    if (block && block !== document.body && block !== document.documentElement &&
        (block.innerText || "").length <= searchText.length * 3) {
      $(block).addClass("read-aloud-highlight");
      return {el: block, pos: nIdx};
    }
    // No bounding block — bare text directly under a huge container, e.g. legacy HTML
    // where a paragraph sits between <p> separators with no wrapper of its own. Wrap the
    // first text run in one inline box: enough to mark the spot for the scroll jump,
    // without fragmenting into per-node boxes.
    var node = textNodes[s.ni];
    var r = document.createRange();
    r.setStart(node, s.off);
    r.setEnd(node, node.nodeValue.length);
    try {
      var mark = document.createElement("read-aloud-hl");
      r.surroundContents(mark);
      return {el: mark, pos: nIdx};
    } catch(_) { return null; }
  }

  var BLOCK_TAGS = { P:1, DIV:1, LI:1, BLOCKQUOTE:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, DD:1, DT:1, FIGCAPTION:1, PRE:1, TD:1, SECTION:1, ARTICLE:1, ASIDE:1, UL:1, OL:1 };
}
