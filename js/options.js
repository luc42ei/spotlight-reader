
(function() {
  const queryString = getQueryString()
  const domReadyPromise = domReady()
  const playerCheckIn$ = new rxjs.Subject()

  registerMessageListener("options", {
    playerCheckIn() {
      playerCheckIn$.next()
    }
  })


  //i18n
  domReadyPromise
    .then(setI18nText)



  //close button
  domReadyPromise
    .then(() => {
      if (queryString.referer) {
        $("button.close").show()
          .click(function() {
            history.back();
          })
      }
    })



  //account button
  domReadyPromise
    .then(() => {
      $("#account-button")
        .click(function() {
          getAuthToken({interactive: true})
            .then(token => brapi.tabs.create({url: config.webAppUrl + "/premium-voices.html?t=" + token}))
            .catch(handleError)
          return false;
        })
      $("#logout-button")
        .click(function() {
          clearAuthToken()
          return false;
        })
    })

  rxjs.combineLatest([
      observeSetting("authToken").pipe(
        rxjs.switchMap(token => token ? getAccountInfo(token) : Promise.resolve(null))
      ),
      domReadyPromise
    ])
    .subscribe(([account]) => showAccountInfo(account))



  //hotkey
  domReadyPromise
    .then(() => {
    })



  //voice
  domReadyPromise
    .then(() => {
      $("#voice-filter").on("input", applyVoiceFilter);

      $("#voices")
        .change(function() {
          var voiceName = $(this).val();
          if (voiceName == "@premium") brapi.tabs.create({url: "premium-voices.html"});
          else if (voiceName == "@piper") bgPageInvoke("managePiperVoices").catch(console.error)
          else if (voiceName == "@supertonic") {
            const $sel = $(this)
            $sel.prop("disabled", true)
            installSupertonicVoices()
              .then(() => location.reload())
              .catch(err => {
                hideSupertonicProgress()
                $sel.prop("disabled", false)
                $("#supertonic-progress").text("Download failed: " + (err.message || err)).show()
                console.error(err)
              })
          }
          else updateSettings({voiceName})
          updateFavStar()
        });
      $("#fav-toggle").click(async function() {
        const voiceName = $("#voices").val()
        if (!voiceName || voiceName.startsWith("@")) return
        const {favoriteVoices} = await brapi.storage.local.get(["favoriteVoices"])
        const favs = favoriteVoices || []
        const idx = favs.indexOf(voiceName)
        if (idx >= 0) favs.splice(idx, 1)
        else favs.push(voiceName)
        await updateSettings({favoriteVoices: favs})
        updateFavStar()
      });
      // lang picker open/close
      $("#lang-picker-btn").click(function(e) {
        e.stopPropagation()
        $("#lang-picker-panel").toggle()
      })
      $("#lang-picker-panel").click(e => e.stopPropagation())
      $(document).click(() => $("#lang-picker-panel").hide())
    })

  const voicesPopulatedObservable = rxjs.combineLatest([
    voices$,
    observeSetting("languages"),
    brapi.i18n.getAcceptLanguages().catch(err => {console.error(err); return []}),
    observeSetting("awsCreds"),
    observeSetting("gcpCreds"),
    observeSetting("ibmCreds"),
    observeSetting("openaiCreds"),
    observeSetting("azureCreds"),
    observeSetting("authToken"),
    observeSetting("favoriteVoices"),
    domReadyPromise
  ]).pipe(
      rxjs.tap(([voices, languages, acceptLangs, awsCreds, gcpCreds, ibmCreds, openaiCreds, azureCreds, authToken, favoriteVoices]) => {
        const panelOpen = $("#lang-picker-panel").is(":visible")
        buildLangPicker(voices, languages)
        if (panelOpen) $("#lang-picker-panel").show()
        populateVoices(voices, {languages, awsCreds, gcpCreds, ibmCreds, openaiCreds, azureCreds, authToken}, acceptLangs)
        buildVoiceChips(favoriteVoices || [])
        applyVoiceFilter()
      }),
      rxjs.share()
    )

  rxjs.combineLatest([observeSetting("voiceName"), voicesPopulatedObservable])
    .subscribe(([voiceName]) => {
      $("#voices").val(voiceName || "")
      updateFavStar()
    })

  rxjs.combineLatest(
    observeSetting("voiceName"),
    observeSetting("gcpCreds"),
    domReadyPromise
  ).subscribe(([voiceName, gcpCreds]) => {
    $("#voice-info").toggle(!!voiceName && isGoogleWavenet({voiceName}) && !gcpCreds)
  })

  rxjs.combineLatest([
    observeSetting("voiceName"),
    observeSetting("lastAutoVoice"),
    domReadyPromise
  ]).subscribe(([voiceName, lastAutoVoice]) => {
    const show = !voiceName && !!lastAutoVoice
    $("#auto-voice-label").toggle(show).text(show ? "Auto: " + lastAutoVoice : "")
  })



  //rate
  const rateSliderPromise = domReadyPromise
    .then(() => {
      const slider = createSlider($("#rate").get(0), {
          format: v => Math.pow($("#rate").data("pow"), v).toFixed(2) + "x",
          onChange(value) {
            const rate = Math.pow($("#rate").data("pow"), value)
            updateSetting("rate" + $("#voices").val(), Number(rate.toFixed(3)))
          }
        })
      $("#rate-edit-button")
        .click(function() {
          $("#rate, #rate-value, #rate-input-div").toggle();
        });
      $("#rate-input")
        .change(function() {
          var val = $(this).val().trim();
          if (isNaN(val)) $(this).val(1);
          else if (val < .1) $(this).val(.1);
          else if (val > 10) $(this).val(10);
          else $("#rate-edit-button").hide();
          updateSetting("rate" + $("#voices").val(), Number($(this).val()))
        });
      return slider
    })

  const rateObservable = observeSetting("voiceName")
    .pipe(
      rxjs.switchMap(voiceName => observeSetting("rate" + (voiceName || ""))),
      rxjs.share()
    )

  rxjs.combineLatest([rateObservable, rateSliderPromise])
    .subscribe(([rate, slider]) => {
      slider.setValue(Math.log(rate || defaults.rate) / Math.log($("#rate").data("pow")))
      $("#rate-input").val(rate || defaults.rate)
    })

  rxjs.combineLatest([observeSetting("voiceName"), rateObservable, domReadyPromise])
    .subscribe(([voiceName, rate]) => {
      $("#rate-warning").toggle((!voiceName || isNativeVoice({voiceName})) && rate > 2)
    })







  //showHighlighting
  domReadyPromise
    .then(() => {
      $("#show-highlighting").on("click", "button", function() {
        updateSettings({showHighlighting: $(this).data("value")})
      })
    })

  rxjs.combineLatest([observeSetting("showHighlighting"), domReadyPromise])
    .subscribe(([showHighlighting]) => {
      const val = String(showHighlighting != null ? showHighlighting : defaults.showHighlighting)
      $("#show-highlighting button").removeClass("active").filter(`[data-value="${val}"]`).addClass("active")
    })



  //audioPlayback
  Promise.all([brapi.storage.local.get(["useEmbeddedPlayer"]), domReadyPromise])
    .then(([settings]) => {
      $("#audio-playback")
        .change(function() {
          updateSettings({useEmbeddedPlayer: JSON.parse($(this).val())})
          brapi.runtime.sendMessage({dest: "player", method: "close"})
            .catch(err => "OK")
        })
      $(".audio-playback-visible").toggle(settings.useEmbeddedPlayer ? true : false)
    })

  rxjs.combineLatest([observeSetting("useEmbeddedPlayer"), domReadyPromise])
    .subscribe(([useEmbeddedPlayer]) => {
      $("#audio-playback").val(useEmbeddedPlayer ? "true" : "false")
    })



  //darkMode
  domReadyPromise.then(() => {
    $("#toggle-dark-mode-options").click(function() {
      const darkMode = document.body.classList.toggle("dark-mode")
      updateSettings({darkMode})
    })
  })
  rxjs.combineLatest([observeSetting("darkMode"), domReadyPromise])
    .subscribe(([darkMode]) => {
      document.body.classList.toggle("dark-mode", !!darkMode)
    })



  //voiceTest
  const demoSpeech = {
    get(lang) {
      return this[lang] || (
        this[lang] = ajaxGet(config.serviceUrl + "/read-aloud/get-demo-speech-text/" + lang).then(JSON.parse)
      )
    }
  }
  const voiceTestSubject = new rxjs.Subject()
  rxjs.defer(() => domReadyPromise).pipe(
    rxjs.exhaustMap(() =>
      voiceTestSubject.pipe(
        rxjs.switchScan(({state}) =>
          rxjs.iif(
            () => state == "STOPPED",
            //play
            rxjs.defer(() => {
              return voices$.pipe(rxjs.take(1))
            }).pipe(
              rxjs.exhaustMap(voices => {
                const voiceName = $("#voices").val()
                const voice = voiceName && findVoiceByName(voices, voiceName)
                const {lang} = parseLang(voice && getFirstLanguage(voice) || "en-US")
                return rxjs.defer(() => demoSpeech.get(lang)).pipe(
                  rxjs.exhaustMap(({text}) => bgPageInvoke("playText", [text, {lang}]))
                )
              }),
              rxjs.exhaustMap(() =>
                rxjs.timer(100, 500).pipe(
                  rxjs.exhaustMap(() => bgPageInvoke("getPlaybackState")),
                  rxjs.takeWhile(({state}) => state != "STOPPED", true)
                )
              )
            ),
            //stop
            rxjs.defer(() => bgPageInvoke("stop")).pipe(
              rxjs.map(() => ({state: "STOPPED"}))
            )
          ),
          {state: "STOPPED"}
        ),
        rxjs.startWith({state: "STOPPED"})
      )
    )
  ).subscribe({
    next({state, playbackError}) {
      $("#test-voice .spinner").toggle(state == "LOADING")
      $("#test-voice [data-i18n]").text(
        brapi.i18n.getMessage(state == "STOPPED" ? "options_test_button" : "options_stop_button")
      )
      if (state == "STOPPED" && playbackError) handleError(playbackError)
      else $("#status").parent().hide()
    },
    error: handleError
  })



  //buttons
  domReadyPromise
    .then(() => {
      $("#test-voice").click(() => voiceTestSubject.next())
      $("#reset")
        .click(function() {
          clearSettings()
        });
    })



  //status
  domReadyPromise
    .then(() => {
      $("#status").parent().hide()
    })

  settingsChange$
    .subscribe(() => {
      showConfirmation()
    })





  const langDisplayNames = (() => {
    try { return new Intl.DisplayNames([navigator.language, 'en'], {type: 'language'}) }
    catch(e) { return {of: c => c} }
  })()

  function buildLangPicker(allVoices, selectedLangsStr) {
    const usableVoices = allVoices.filter(v => !isNativeVoice(v))
    const voicesForLang = groupVoicesByLang(usableVoices)
    const selectedLangs = selectedLangsStr ? selectedLangsStr.split(',').filter(Boolean) : []

    const langs = Object.keys(voicesForLang)
      .filter(c => c !== '<any>')
      .map(code => ({code, name: langDisplayNames.of(code) || code}))
      .sort((a, b) => a.name.localeCompare(b.name))

    const $panel = $("#lang-picker-panel").empty()
    langs.forEach(({code, name}) => {
      const $label = $("<label>").addClass("lang-check-item")
      $("<input>").attr("type", "checkbox").val(code).prop("checked", selectedLangs.includes(code))
        .on("change", function() {
          const checked = $("#lang-picker-panel input:checked").map((_, el) => el.value).get()
          updateSettings({languages: checked.join(',')})
          updateLangBtn(checked)
        })
        .appendTo($label)
      $("<span>").text(name).appendTo($label)
      $label.appendTo($panel)
    })

    updateLangBtn(selectedLangs)
  }

  function updateLangBtn(selected) {
    let label
    if (!selected.length) label = "All languages"
    else if (selected.length <= 3) label = selected.map(c => langDisplayNames.of(c) || c).join(", ")
    else label = selected.length + " languages"
    $("#lang-picker-btn").text(label + " \u25be")
  }

  var currentFavorites = []

  async function updateFavStar() {
    const voiceName = $("#voices").val()
    const {favoriteVoices} = await brapi.storage.local.get(["favoriteVoices"])
    const isFav = voiceName && (favoriteVoices || []).includes(voiceName)
    $("#fav-toggle")
      .toggleClass("active", !!isFav)
      .find(".material-icons").text(isFav ? "star" : "star_border")
  }

  function applyVoiceFilter() {
    const raw = $("#voice-filter").val()
    const isFavFilter = raw === "@fav"
    const filter = isFavFilter ? "" : raw.toLowerCase()
    $("#voices option").each(function() {
      const name = $(this).val()
      const text = $(this).text().toLowerCase()
      let show = true
      if (isFavFilter) show = !name || currentFavorites.includes(name)
      else if (filter) show = text.includes(filter)
      $(this).css("display", show ? "" : "none");
    });
    $("#voices optgroup").each(function() {
      const hasVisible = $(this).find("option").filter((_, o) => $(o).css("display") !== "none").length > 0;
      $(this).css("display", hasVisible ? "" : "none");
    });
  }

  function chipLabelFor(firstWord) {
    const providers = ["Google", "Amazon", "IBM", "OpenAI", "Azure", "Microsoft", "ReadAloud", "Supertonic", "Piper", "RHVoice"]
    for (const p of providers) {
      if (firstWord.startsWith(p)) {
        const rest = firstWord.slice(p.length).replace(/-/g, " ").trim()
        return rest ? p + " " + rest : p
      }
    }
    return firstWord
  }

  function buildVoiceChips(favorites) {
    currentFavorites = favorites
    const groups = {}
    $("#voices optgroup").not("[data-type='offline'],[data-type='experimental']").find("option").each(function() {
      const text = $(this).text().trim()
      if (!text || text.startsWith("@") || text === "Auto select") return
      const firstWord = text.split(" ")[0]
      if (!groups[firstWord]) groups[firstWord] = {label: chipLabelFor(firstWord), count: 0}
      groups[firstWord].count++
    })

    const currentFilter = $("#voice-filter").val()
    const $container = $("#voice-chips").empty()

    if (favorites.length) {
      $("<button>")
        .addClass("voice-chip voice-chip-fav")
        .toggleClass("active", currentFilter === "@fav")
        .text("\u2605 Favorites")
        .on("click", function() {
          const next = $("#voice-filter").val() === "@fav" ? "" : "@fav"
          $("#voice-filter").val(next)
          $(".voice-chip").removeClass("active")
          if (next) $(this).addClass("active")
          applyVoiceFilter()
        })
        .appendTo($container)
    }

    Object.entries(groups)
      .filter(([, {count}]) => count >= 2)
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .forEach(([filter, {label}]) => {
        $("<button>")
          .addClass("voice-chip")
          .toggleClass("active", currentFilter === filter)
          .text(label)
          .on("click", function() {
            const next = $("#voice-filter").val() === filter ? "" : filter
            $("#voice-filter").val(next)
            $(".voice-chip").removeClass("active")
            if (next) $(this).addClass("active")
            applyVoiceFilter()
          })
          .appendTo($container)
      })
  }

  function populateVoices(allVoices, settings, acceptLangs) {
    const {awsCreds, gcpCreds, ibmCreds, openaiCreds, azureCreds, authToken} = settings

    // Filter out voices that won't work
    allVoices = allVoices.filter(function(voice) {
      if (isNativeVoice(voice)) return false          // browser built-in (espeak etc.) — poor quality
      if (isPremiumVoice(voice)) return !!authToken
      if (isAmazonPolly(voice)) return !!awsCreds
      if (isGoogleWavenet(voice)) return !!gcpCreds
      if (isIbmWatson(voice)) return !!ibmCreds
      if (isOpenai(voice)) return !!openaiCreds
      if (isAzure(voice)) return !!azureCreds
      return true
    })

    $("#voices").empty()
    $("<option>")
      .val("")
      .text("Auto select")
      .appendTo("#voices")

    //get voices filtered by selected languages
    var selectedLangs = immediate(() => {
      if (settings.languages) return settings.languages.split(',')
      if (settings.languages == '') return null
      const accept = new Set(acceptLangs.map(x => x.split('-',1)[0]))
      const langs = Object.keys(groupVoicesByLang(allVoices)).filter(x => accept.has(x))
      return langs.length ? langs : null
    })
    var voices = !selectedLangs ? allVoices : allVoices.filter(
      function(voice) {
        const voiceLanguages = getVoiceLanguages(voice)
        return !voiceLanguages
          || voiceLanguages.map(parseLang).some(({ lang }) => selectedLangs.includes(lang))
          || isPiperVoice(voice)
          || isSupertonicVoice(voice)
          || isOpenai(voice)
      });

    var groups = Object.assign({
        experimental: [],
        offline: [],
        standard: [],
        premium: [],
      },
      voices.groupBy(function(voice) {
        if (isPiperVoice(voice)) return "experimental"
        if (isSupertonicVoice(voice) || isNativeVoice(voice)) return "offline"
        if (isGoogleTranslate(voice)) return "standard"
        return "premium"
      }))
    for (var name in groups) groups[name].sort(voiceSorter);

    function addGroup(label, type, voices, extra) {
      if (!voices.length && !extra) return
      const g = $("<optgroup>").attr("label", label)
      if (type) g.attr("data-type", type)
      voices.forEach(v => $("<option>").val(v.voiceName).text(v.voiceName).appendTo(g))
      if (extra) extra(g)
      g.appendTo($("#voices"))
    }

    addGroup(brapi.i18n.getMessage("options_voicegroup_experimental"), "experimental", groups.experimental, g => {
      $("<option>").val("@piper").text(brapi.i18n.getMessage("options_enable_piper_voices")).appendTo(g)
    })
    addGroup(brapi.i18n.getMessage("options_voicegroup_offline"), "offline", groups.offline, g => {
      if (!groups.offline.some(isSupertonicVoice))
        $("<option>").val("@supertonic").text(brapi.i18n.getMessage("options_enable_supertonic_voices")).appendTo(g)
    })
    addGroup(brapi.i18n.getMessage("options_voicegroup_standard"), null, groups.standard)
    addGroup(brapi.i18n.getMessage("options_voicegroup_premium"), null, groups.premium)
  }

  function voiceSorter(a, b) {
    function getWeight(voice) {
      var weight = 0
      //native voices should appear before non-natives in Standard group
      if (!isNativeVoice(voice)) weight += 10
      //ReadAloud Generic Voice should appear first among the non-natives
      if (!isReadAloudCloud(voice)) weight += 1
      //UseMyPhone should appear last in Offline group
      if (isUseMyPhone(voice)) weight += 1
      return weight
    }
    return getWeight(a)-getWeight(b) || a.voiceName.localeCompare(b.voiceName)
  }



  function showConfirmation() {
    $(".green-check").finish().show().delay(500).fadeOut();
  }

  function handleError(err) {
    if (/^{/.test(err.message)) {
      var errInfo = JSON.parse(err.message);
      $("#status").html(formatError(errInfo)).parent().show();
      $("#status a").click(function() {
        switch ($(this).attr("href")) {
          case "#sign-in":
            getAuthToken({interactive: true})
              .then(function(token) {
                if (token) {
                  $("#test-voice").click();
                  getAccountInfo(token).then(showAccountInfo);
                }
              })
              .catch(function(err) {
                $("#status").text(err.message).parent().show();
              })
            break;
          case "#auth-wavenet":
            brapi.permissions.request(config.wavenetPerms)
              .then(function(granted) {
                if (granted) bgPageInvoke("authWavenet");
              })
            break;
          case "#connect-phone":
            location.href = "connect-phone.html"
            break
        }
      })
    }
    else if (config.browserId == "opera" && /locked fullscreen/.test(err.message)) {
      $("#status").html("Click <a href='#open-player-tab'>here</a> to start read aloud.").parent().show()
      $("#status a").click(async function() {
        try {
          playerCheckIn$.pipe(rxjs.take(1)).subscribe(() => $("#test-voice").click())
          const tab = await brapi.tabs.create({
            url: "player.html?opener=options&autoclose=long",
            index: 0,
            active: false,
          })
          brapi.tabs.update(tab.id, {pinned: true})
            .catch(console.error)
        } catch (err) {
          handleError(err)
        }
      })
    }
    else {
      $("#status").text(err.message).parent().show();
    }
  }

  function showAccountInfo(account) {
    if (account) {
      $("#account-email").text(account.email);
      $("#account-info").show();
    }
    else {
      $("#account-info").hide();
    }
  }



  function createSlider(elem, {onChange, onSlideChange, format}) {
    var min = $(elem).data("min") || 0;
    var max = $(elem).data("max") || 1;
    var step = 1 / ($(elem).data("steps") || 20);
    var $bg = $(elem).empty().toggleClass("slider", true);
    var $bar = $("<div class='bar'>").appendTo(elem);
    var $track = $("<div class='track'>").appendTo(elem);
    var $knob = $("<div class='knob'>").appendTo($track);
    var $valueEl = $(elem).next(".slider-value");

    $bg.click(function(e) {
      var pos = calcPosition(e);
      setPosition(pos);
      onChange(min + pos*(max-min));
    })
    $knob.click(function() {
      return false;
    })
    $knob.on("mousedown touchstart", function() {
      onSlideStart(function(e) {
        var pos = calcPosition(e);
        setPosition(pos);
        if (onSlideChange) onSlideChange(min + pos*(max-min));
      },
      function(e) {
        var pos = calcPosition(e);
        setPosition(pos);
        onChange(min + pos*(max-min));
      })
      return false;
    })
    return {
      setValue(value) {
        setPosition((Math.min(value, max)-min) / (max-min))
      }
    }

    function setPosition(pos) {
      var percent = (100 * pos) + "%";
      $knob.css("left", percent);
      $bar.css("width", percent);
      if ($valueEl.length && format) {
        $valueEl.text(format(min + pos * (max - min)));
      }
    }
    function calcPosition(e) {
      var rect = $track.get(0).getBoundingClientRect();
      var position = (e.clientX - rect.left) / rect.width;
      position = Math.min(1, Math.max(position, 0));
      return step * Math.round(position / step);
    }
  }

  function onSlideStart(onSlideMove, onSlideStop) {
    $(document).on("mousemove", onSlideMove);
    $(document).on("mouseup mouseleave", onStop);
    $(document).on("touchmove", onTouchMove);
    $(document).on("touchend touchcancel", onTouchEnd);

    function onTouchMove(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onSlideMove(e);
      return false;
    }
    function onTouchEnd(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onStop(e);
      return false;
    }
    function onStop(e) {
      $(document).off("mousemove", onSlideMove);
      $(document).off("mouseup mouseleave", onStop);
      $(document).off("touchmove", onTouchMove);
      $(document).off("touchend touchcancel", onTouchEnd);
      if (onSlideStop) onSlideStop(e);
      return false;
    }
  }

  function showSupertonicProgress(step, total) {
    const text = step ? `(${step}/${total})` : ""
    $("#supertonic-progress-text").text(text)
    $("#supertonic-progress").show()
  }

  function hideSupertonicProgress() {
    $("#supertonic-progress").hide()
  }

  async function installSupertonicVoices() {
    const HF_BASE = "https://huggingface.co/Supertone/supertonic-2/resolve/main"
    const CACHE_NAME = "supertonic-models-v1"
    const files = [
      "onnx/duration_predictor.onnx",
      "onnx/text_encoder.onnx",
      "onnx/vector_estimator.onnx",
      "onnx/vocoder.onnx"
    ]
    const cache = await caches.open(CACHE_NAME)
    for (let i = 0; i < files.length; i++) {
      showSupertonicProgress(i + 1, files.length)
      const url = `${HF_BASE}/${files[i]}`
      if (!await cache.match(url)) {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed to fetch ${files[i]}: ${resp.status}`)
        await cache.put(url, resp)
      }
    }
    const voices = ["F1","F2","F3","F4","F5","M1","M2","M3","M4","M5"].map(id => ({
      voiceName: "Supertonic " + id,
      lang: "en",
      langs: ["en", "ko", "es", "pt", "fr"]
    }))
    await updateSettings({supertonicVoices: voices})
  }
})();
