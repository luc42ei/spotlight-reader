# Issue #20 – Android: Vorlesen bei gesperrtem Bildschirm weiterlaufen lassen

**Issue:** luc42ei/spotlight-reader#20 · **Upstream:** ken107/read-aloud#512 (Fix aa42a92 laut Reporter wirkungslos) · **Erstellt:** 2026-11-18
**Status:** umgesetzt · **Branch:** `feat/20-android-lockscreen`
**Umsetzung mit:** Opus – Ursache erst am Gerät zu ermitteln (Baseline kann den Plan kippen), Messdeutung Android/Doze/Timing, Gecko-Verhalten (Mediensteuerung, Hörbarkeit) unbelegt

# Teil A: Spec (Was/Warum)

## 1. Problem

Issue: „Firefox für Android: Vorlesen läuft weiter, wenn der Bildschirm gesperrt ist (Handy in die Tasche, Artikel weiterhören).“ Upstream-Reporter (Android 10, FF 152): Wiedergabe stoppt ~4 min nach Bildschirm-aus; seit aa42a92 „most of the time terminates with network error … starts from the very beginning of the page“.

Akzeptanz (Issue):
- 15+ min Wiedergabe bei gesperrtem Bildschirm (mind. Google Translate und Supertonic)
- Steuerung auf dem Sperrbildschirm (Pause/Weiter)
- Desktop-Verhalten unverändert (präzisiert: Media Session auch am Desktop, s. §8)

## 2. Ursache / Ausgangslage

Ursache ist **nicht gemessen** (kein Gerätetest bisher, auch #17 nicht). Fakten aus dem Code:

- **Audio lebt im Player-Tab** (`player.html?autoclose`, inaktiv, `js/events.js:586` `createPlayerTab`). Ein einziges Sprach-Element `getSingletonAudio` (`js/defaults.js:48-52`), nicht im DOM. Alle Engines (GT, Cloud, Supertonic als Blob-URL) laufen über `playAudio` → `playAudioHere` (`js/player.js:376`, `js/defaults.js:905`).
- **Silence-Track** (`js/defaults.js:966-1006`, `sound/silence.mp3`, 10 s, 8 kHz mono, `loop`): `playAudioHere` startet ihn nach `audio.play()` und stoppt ihn im `finalize` (`js/defaults.js:937-949`); `stop()` pausiert erst nach **15 s** (STOPPING-Timer `:985`), ein `start()` vorher bricht ab. → Er läuft schon während der Wiedergabe und überbrückt Chunk-Lücken bis 15 s. Die Issue-Aussage „nur während des Pufferns“ stimmt so nicht; Lücken > 15 s (Supertonic-Synthese auf dem Handy langsamer als Echtzeit, Netz-Timeouts) und der **erste Ladevorgang** sind ungedeckt.
  ```js
  // js/defaults.js:937-949
  rxjs.defer(async () => {
    try {
      await audio.play()
      silenceTrack.start()
  ...
    rxjs.finalize(() => {
      audio.pause()
      silenceTrack.stop()
    })
  ```
- **Wake Lock** (`js/defaults.js:787-833`, `maintainPlaybackWakeLock`): nur Popup (`js/popup.js:5`) und gelesene Seite (`js/content.js:4`), `screen`-Lock wird bei Sperre/`document.hidden` freigegeben → hilft bei gesperrtem Bildschirm prinzipbedingt nicht. Bleibt unverändert (verhindert weiterhin Auto-Abschalten bei offenem Bildschirm).
- **`navigator.mediaSession`**: 0 Treffer in `js/` und `lib/`. Folge Desktop heute: Medientaste pausiert über Geckos Standard-Handler direkt das `<audio>`-Element am Zustand vorbei (Speech bleibt `resumed`, Popup zeigt „spielt“) – Vermutung, in Schritt 0 prüfen.
- **Steuerung im Player** (`js/player.js:215-230, 341-349`): `stop()`, `pause()`, `resume()` (= `activeDoc.play()`), `forward()`, `rewind()` – dieselben Funktionen, die Popup/Steuerleiste über Background → `sendToPlayer` erreichen (`js/events.js:12-29, 361-393, 599`).
- **Zustand**: `activeDoc.getState()` → `LOADING|PLAYING|PAUSED` (`js/document.js:358`, `js/speech.js:182`), kein Event – Popup/Steuerleiste pollen (`js/popup.js:145`, `js/control-bar.js:181`). Player hat bereits Intervalle 500 ms (Highlight, `js/player.js:278`) und 2 s (Leseposition, `js/player.js:298`).
- **Titel/URL**: `content.js:28-34` `getInfo()` liefert `{url, title, lang, canSeek}`; `Doc` hält es als privates `info` (`js/document.js:136-141`), kein Getter. `SimpleSource` (Auswahltext) hat weder `url` noch `title` (`js/document.js:3-5`).
- **Fehlerpfad**: Engine-/Audiofehler → `Speech.onEnd(err)` (`js/speech.js:331-337`) → `openDoc`-Callback `handleError; closeDoc()` (`js/player.js:256-261`) → Zustand STOPPED, `playbackError` fürs Popup. Kein Retry.
- **Wiederaufnahme existiert** (v3.2.6, #15): Player speichert alle 2 s den ersten Satz des aktuellen Chunks (`js/player.js:294-316`, ab Chunk 1), `playTab` setzt über `applyResumePosition` (`js/events.js:296`, Aufruf `:327`) `__raSeekTarget{resume}`. Der Upstream-Befund „Neustart ab Seitenanfang“ trifft unseren Fork daher nur, wenn keine Position gespeichert wurde (Chunk 0, oder Intervall bei Sperre gedrosselt) – in Schritt 0 messen.
- **Prefetch**: nur beim `load` eines Chunks, Tiefe `engine.prefetchDepth || 2` (`js/speech.js:292-301`); GT liefert data-URLs (`js/tts-engines.js:128-134`), Supertonic `prefetchDepth = 4` (`:1087`).

**Hypothesen (Issue, zu messen in Schritt 0):**
1. Pausen ohne (hörbares) Audio → Firefox/GeckoView sieht keine aktive Medienwiedergabe → Medien-Foreground-Service/Benachrichtigung endet → Prozess wird gedrosselt/eingefroren, Netz im Doze gekappt.
2. Gedrosseltes JS/Netz → nächster Chunk zu spät, Fetch-Fehler.
3. Tab-/Content-Prozess entladen (z. B. Speicherdruck bei Supertonic mit 2–3 Workern à ~0,5 GB) → Zustand weg.

## 3. Lösung

- **Ansatz:** zwei Bausteine im Player-Tab, je einzeln gemessen:
  - **A – Media Session** (`js/player.js`): `navigator.mediaSession.metadata` (Titel = Seitentitel, Künstler = Hostname, Album = Add-on-Name, Artwork `img/icon.png`), Aktions-Handler `play`/`pause`/`stop`/`nexttrack`/`previoustrack` → bestehende `resume`/`pause`/`stop`/`forward`/`rewind`, `playbackState` aus `activeDoc.getState()`. Wirkt überall (Desktop: Medientasten/OS-Anzeige). Liefert die Sperrbildschirm-Steuerung (Akzeptanz 2) und kennzeichnet die Wiedergabe als Medium (Hypothese 1).
  - **B – Silence-Track durchgehend**, solange ein Doc aktiv und nicht pausiert ist (`LOADING`/`PLAYING`), **erst nachdem der Player-Tab die Autoplay-Freigabe hat**: derselbe Sync-Takt wie A ruft `getSilenceTrack().start()`; Pause/Stop laufen über den bestehenden 15-s-Auslauf bzw. explizites `stop()` in `closeDoc`. Kein Umbau von `makeSilenceTrack`/`playAudioHere` – `start()` ist in PLAYING ein No-op und bricht in STOPPING den Timer ab. Die Schranke ist nötig, weil `IDLE.start()` auch bei abgelehntem `audio.play()` (Autoplay-Sperre, `NotAllowedError`) nach `PLAYING` wechselt (`js/defaults.js:972-975`) und der Takt den Track danach nie mehr nach IDLE ließe. Sie hängt an der tatsächlichen Freigabe (`requestAudioPlaybackPermission` erfüllt, `js/player.js:385-408`), **nicht** am Zustand: `Speech.getState()` meldet direkt nach `play()` bis zu 2 s „PLAYING“, weil `isLoading$` den Wechsel auf `true` um 2 s verzögert (`js/speech.js:219-228`) – auch während der Freigabe-Dialog noch offen ist.
  - **Gerätemessung entscheidet** (Schritt 0 → A → Messung → B → Messung). Reicht A+B nicht für 15 min, ist die Ursache eine andere (z. B. Speicherdruck/Entladen, Hypothese 3) → Umsetzung stoppt mit Befund an Lucas, kein Pflaster (s. §9).
- **Begründung:** Medien-Apps halten unter Android über eine Media-Session/Foreground-Service den Prozess am Leben; Firefox für Android zeigt dafür eine Medienbenachrichtigung pro Tab mit Medienwiedergabe. Beides nutzt bestehende Player-Funktionen, keine Permission, kein Server-Kontakt, ~50 Zeilen.
- **Pflaster-Check:** (1) Absicht: Akzeptanz 1 nur nach Messung belegbar → Messung ist Teil der Abnahme; Akzeptanz 2 erfüllt A; Akzeptanz 3 durch Desktop-Smoke. (2) Kein späterer Umbau: Media Session ist der Standardweg, Handler rufen dieselben Funktionen wie Popup. (3) Kein zweiter Weg: keine eigene Zustandsmaschine, Silence-Track wiederverwendet statt zweites Audio.
- **Verworfen:**
  - Screen-Wake-Lock im Player-Tab – Player-Tab ist immer `document.hidden`, Lock wird bei Sperre ohnehin freigegeben.
  - Prefetch „tiefer bei gesperrtem Bildschirm“ – Sperre ist im Player nicht erkennbar (Tab immer hidden); zudem hilft Vorladen nur Minuten, wenn das Netz im Doze weg ist. Nur bei Messbefund (§7).
  - Automatischer Retry nach Netzwerkfehler – Fehler sollen durch A/B gar nicht erst entstehen; Wiederaufnahme an der gespeicherten Position existiert (#15). Nur bei Messbefund (§7).
  - Hörbares Rauschen statt Stille als „aktives Medium“ – Qualitätseinbuße, Pflaster.

## 4. Messung (Baseline = Abnahme)

Gerät: Lucas' Android-Handy, Firefox (Version notieren). Baseline mit der installierten AMO-Version 3.4.0 (= `master`-Code), Testbuilds per `npx --yes web-ext run -t firefox-android --android-device <id> --firefox-apk org.mozilla.firefox` (temporär; AMO-Version vorher in Firefox deaktivieren). **Maßgeblich ist der echte Lauf ohne Kabel** (USB lädt → kein Doze): Wiedergabe per Kabel starten, Log läuft auf dem Gerät weiter (P1 Schritt 2), Kabel ab, sperren. `adb shell dumpsys deviceidle force-idle` nur als Zusatz-Diagnose für **Supertonic** (lokal): Deep-Doze kappt das Netz, ein GT-Stopp wäre dort kein Befund über den Keepalive. Die Baseline gilt nur, wenn ohne Fix ein Stopp < 15 min auftritt; sonst Befund an Lucas, bevor gebaut wird (dann ist das Problem auf diesem Gerät nicht reproduzierbar). Testseite: langer Wikipedia-Artikel (≥ 20 min Vorlesezeit, z. B. `https://de.wikipedia.org/wiki/Geschichte_Berlins`), Tempo 1,0. Protokoll in §13 Schritt 0.

| KPI | Methode | Baseline | Ziel |
| --- | --- | --- | --- |
| K1 Laufzeit gesperrt bis Stopp (min, Abbruch bei 15) – GT | Protokoll P1, Stoppuhr | – | ≥ 15 |
| K1 – Supertonic (Standard, `supertonicParallel` wie Default) | Protokoll P1 | – | ≥ 15 |
| K2 Firefox-Medienbenachrichtigung / Foreground-Service während Sperre | Sichtprüfung + `adb shell dumpsys activity services org.mozilla.firefox \| grep -i -E "media\|isForeground"` | – | ja, durchgehend |
| K3 Art des Stopps | Popup-Fehlertext nach Entsperren, Remote-Konsole Player-Tab, `adb logcat` (Filter P1) | – | kein Stopp |
| K4 Sperrbildschirm-Steuerung Play/Pause/Vor/Zurück | Protokoll P2 | 0/4 erwartet | 4/4 |
| K4b Nach 3 min Pause: Play vom Sperrbildschirm möglich | Protokoll P2 Schritt 3 | – | Befund dokumentieren (kein Muss, s. §9 Nr. 3) |
| K5 Nach Stopp: Play im Popup setzt fort an | Protokoll P1 Schritt 7 (Absatz Stopp vs. Neustart) | – | gleiche Stelle ±1 Chunk |
| K6 Desktop: Medientaste Play/Pause, Popup-Status stimmt danach | Protokoll P3 (Firefox Desktop, Linux) | – (Vermutung: Status falsch) | ja |

## Entschieden vom Agenten

| Entscheidung | Verworfen | Warum | Prinzip |
| --- | --- | --- | --- |
| Kein „Prefetch tiefer bei Sperre“ | Prefetch-Tiefe bei `document.hidden` erhöhen (Issue-Kandidat) | Player-Tab ist immer hidden, Sperre nicht erkennbar; ohne Messbefund kein Effekt belegt | 4 Einfachheit |
| Kein Auto-Retry bei Netzfehler | Retry in Speech/Doc (Issue-Kandidat „an aktueller Position fortsetzen“) | Fork hat Resume (#15); K5 misst, ob es greift. Retry nur bei Befund | 4 Einfachheit |
| Silence-Track über Sync-Takt im Player statt Umbau von `makeSilenceTrack` | Ref-Counting/Keep-Alive-Flag im Track | `start()` ist idempotent, 3 Zeilen statt neuer Zustandslogik in geteilter Datei | 4 Einfachheit |
| Album-Text = Add-on-Name über `brapi.i18n.getMessage("extension_name")` | neuer UI-Text | kein neuer Locale-Schlüssel nötig | 5 Lokalisierung |
| Hostname statt voller URL als „Künstler“ | URL | kürzer, nichts aus Pfad/Query auf dem Sperrbildschirm | 1 Privatsphäre |
| Zusätzlich Handler `stop` (über die Präzisierung „Play/Pause + Vor/Zurück“ hinaus) | weglassen | Desktop-OS-Anzeigen und manche Android-Oberflächen bieten Stop an; ohne Handler würde Gecko nur das Audio-Element anhalten (Zustand falsch) | 3 Funktion |
| Silence-Keepalive im Player, getrennt von `fixBtSilenceGap` (`js/content.js:111-125`) | `shouldPlaySilence`/Content-Script-Track wiederverwenden | `fixBtSilenceGap` ist Opt-in für Bluetooth-Kopfhörer und spielt im **gelesenen** Tab (Provider-Dedup über `shouldPlaySilence`, `js/player.js:411`); der Sperr-Fall braucht Medium im **Player**-Tab, wo das Sprach-Audio läuft, und immer. Der Player nutzt denselben `getSilenceTrack`-Baustein, kein zweiter Mechanismus | 3 Funktion |
| Kein Keepalive während Pause | Stille auch bei Pause weiterspielen | Akku; Pause soll Pause sein. Ob Firefox die Mediensteuerung nach längerer Pause abgibt, misst K4b; Befund → bekannte Grenze | 4 Einfachheit |

## 5. UX

Firefox-Medienbenachrichtigung / Sperrbildschirm (Android) bzw. OS-Medienanzeige (Desktop):

```
┌───────────────────────────────────────┐
│ [Icon]  Geschichte Berlins – Wikipedia │
│         de.wikipedia.org               │
│         Spotlight Reader               │
│      ⏮      ⏸/▶      ⏭                 │
└───────────────────────────────────────┘
```

Auswahltext (kein Titel): Titel = Add-on-Name, kein Künstler. Keine neuen Texte in `_locales`.

## 6. Risiken

| Risiko | Schwere | Umgang |
| --- | --- | --- |
| Firefox Android zeigt keine Medienbenachrichtigung für Extension-Tabs (`moz-extension://`) | hoch | Schritt 0 prüft K2; ohne Benachrichtigung kein Foreground-Service → Befund an Lucas, nicht weiterbauen |
| Gecko wertet stummen Silence-Track als „nicht hörbar“ → zählt nicht als Medium | mittel | Messung nach B zeigt Wirkung; ohne Effekt B wieder entfernen (Diff klein) |
| Desktop: Medientasten steuern jetzt das Vorlesen statt z. B. eines parallel laufenden Videos | niedrig | gewollt (§8); Gecko wählt den zuletzt aktiven Medien-Tab |
| Media-Handler feuern nach `closeDoc` (kein `activeDoc`) | niedrig | Handler rufen bestehende Funktionen, die ohne Doc No-op/Reject sind; `.catch(console.error)` |
| Supertonic auf Handy: Synthese langsamer als Echtzeit → hörbare Lücken trotz Weiterlaufen | mittel | nicht Gegenstand (Leistung, #17); K1 zählt Abbruch, nicht Lücken; Beobachtung notieren |
| Speicherdruck (2–3 Supertonic-Worker) → Prozess-Kill | mittel | Schritt 0 notiert `supertonicParallel` und `logcat` auf `lowmemorykiller`/„Killing“; Befund → §9 |
| B startet Stille vor Autoplay-Freigabe → Track hängt in PLAYING ohne Ton, Lücken-Überbrückung fällt aus (auch Desktop) | hoch | Schranke an erfüllter Freigabe-Promise (§3), nicht am Zustand; P3 (4) prüft Autoplay-blockiert-Fall mit > 5 s offenem Dialog |
| Engines ohne `playAudio`-Pfad (PhoneTts „Use my phone“) setzen nie `audioUnlocked` → kein Keepalive B; schlägt nur `tabs.update(prevTab…)` in `request()` fehl, bleibt `audioUnlocked` bis zum nächsten Versuch false | niedrig | bekannte Grenze |
| Altsetting `useEmbeddedPlayer` (`js/events.js:547-551`): Player als iframe in der Seite → Media Session/B im Seiten-Kontext | niedrig | bekannte Grenze; `canUseEmbeddedPlayer()` ist `false`, Setting nur bei Altinstallationen |

## 7. Nicht im Umfang

| Punkt | warum nicht | Auslöser zum Nachrüsten |
| --- | --- | --- |
| Auto-Retry bei Netzwerkfehler | Ursache soll entfallen; Resume existiert | K3 zeigt nach A+B weiter Netzfehler bei hörbar laufender Session |
| Prefetch-Tiefe für GT erhöhen | kein Befund | K3 zeigt Stall/Timeout bei laufender Session |
| `positionState` (Fortschrittsbalken), `seekto` | Chunk-Zeiten unbekannt, kein Nutzen für Akzeptanz | Nutzerwunsch |
| Supertonic-Leistung/RAM auf Handys | eigenes Thema (#17-Rest) | eigenes Issue |
| Wake-Lock-Code entfernen | wirkt weiter bei offenem Bildschirm | – |

## 8. Geklärte Fragen

| Frage | Antwort | Datum |
| --- | --- | --- |
| Gerät für Messung | Android-Handy mit Firefox + USB-Debugging (adb, about:debugging) | 2026-11-18 |
| Anzeige Sperrbildschirm | Seitentitel + Website | 2026-11-18 |
| Aktionen | Play/Pause + Vor/Zurück (= forward/rewind) | 2026-11-18 |
| Media Session am Desktop | ja, überall | 2026-11-18 |

## 9. Offene Punkte

| Nr | Punkt | Warum nicht klärbar | Folge, wenn anders |
| --- | --- | --- | --- |
| 1 | Hält Firefox Android eine Extension-Tab-Wiedergabe mit Media Session bei Sperre ≥ 15 min am Leben? | nur am Gerät messbar | A+B reichen nicht → Umsetzung stoppt nach Schritt 4 mit Messbefund, neuer Plan (z. B. Retry/Prefetch aus §7, oder Grenze dokumentieren) |
| 2 | `navigator.mediaSession` in `moz-extension://`-Seiten auf Android verfügbar | nur am Gerät | wie 1 |
| 3 | Gibt Firefox die Mediensteuerung nach längerer Pause (Stille nach 15 s aus) ab? | Gecko-Verhalten (Prefs `media.mediacontrol.*`), nur messbar | K4b nein → bekannte Grenze im Umsetzungsbericht + Hinweis an Lucas; kein Keepalive bei Pause ohne neue Entscheidung |
| 4 | `web-ext run -t firefox-android` mit Release-Firefox (`org.mozilla.firefox`) auf Lucas' Gerät; bleibt das temporäre Add-on nach Kabel-Abziehen geladen? | Gerät/Einstellung „Remote-Debugging über USB“ in Firefox | Fallback: Firefox Nightly/Beta-APK mit `--firefox-apk`; bleibt es nicht geladen → WLAN-adb (`adb tcpip 5555`, `adb connect <ip>`) statt Kabel, Lauf ohne Kabel bleibt Maßstab; Baseline bleibt AMO-Version |

## 10. Definition of Done

- [x] K1 ≥ 15 min für GT und Supertonic bei gesperrtem Bildschirm – oder dokumentierter Messbefund + Stopp gemäß §9
- [x] K4 4/4 Sperrbildschirm-Aktionen
- [x] K6 Desktop: Medientaste steuert Vorlesen, Popup-Status stimmt; sonst Desktop unverändert (Smoke P3)
- [x] Vorher/Nachher-Zahlen K1–K6 im Umsetzungsbericht
- [x] Locales: keine neuen Texte
- [x] Review ohne offene Blocker/High

# Teil B: Plan (Wie)

## 11. Pflichtlektüre

| Datei | Zeilen | Warum |
| --- | --- | --- |
| `js/player.js` | 101-141, 173-262, 266-316, 341-356 | Steuerfunktionen, openDoc/closeDoc, bestehende Intervalle |
| `js/document.js` | 136-160, 340-370 | Doc-API, `info`, getState |
| `js/defaults.js` | 48-53, 905-1006 | Audio, Silence-Track |
| `js/content.js` | 28-34 | `getInfo` (title/url) |
| `js/events.js` | 586-600 | Player-Tab |

## 12. Muster zum Übernehmen

Intervall mit try/catch im Player (QUELLE: `js/player.js:278-292`):
```js
setInterval(async function() {
  try {
    if (!activeDoc) return;
    ...
    var speech = await activeDoc.getActiveSpeech();
    if (!speech) return;
  } catch(e) {}
}, 500);
```

Öffentlicher Getter am Doc (QUELLE: `js/document.js:154-156`):
```js
  // url of a page whose reading position can be saved and resumed
  // (not while reading a selection: currentIndex is negative then)
  this.getResumeUrl = () => (info && info.canSeek && currentIndex >= 0) ? info.url : null;
```

Silence-Track-API (QUELLE: `js/defaults.js:53, 997-1004`): `getSilenceTrack().start()` / `.stop()`.

## 13. Schritte

### Schritt 0: Baseline messen (Gerät, unveränderter Stand)

- [x] erledigt
- **Umsetzen:** Protokolle P1–P3 mit `master`-Stand (oder AMO 3.4.0) durchführen, Werte in §4 „Baseline“ eintragen. Zusätzlich in der Remote-Konsole des Player-Tabs `'mediaSession' in navigator` notieren (Offener Punkt 2).
- **Prüfen:** §4 Baseline-Spalte vollständig; Firefox-Version, Android-Version, Gerät notiert.

**P1 – Laufzeit gesperrt (je Engine GT, Supertonic):**
1. Handy per USB, `adb devices` zeigt Gerät; Firefox-Einstellung „Remote-Debugging über USB“ an. Vorher: AMO-Version; nachher: Testbuild per `web-ext run` (§4).
2. Log auf dem Gerät starten (überlebt Kabel ab): `adb logcat -c; adb shell 'nohup logcat -v time -f /data/local/tmp/sr20.log >/dev/null 2>&1 &'`. Firefox-PIDs notieren: `adb shell pidof org.mozilla.firefox org.mozilla.firefox:tab0 org.mozilla.firefox:tab1` (Content-Prozesse heißen `…:tabN`).
3. Testseite öffnen, Stimme wählen, Popup → Play. Warten bis Chunk ≥ 2 (dann ist eine Leseposition gespeichert).
4. Hauptlauf: USB-Kabel abziehen. (Diagnose-Variante nur Supertonic: Kabel bleibt, nach Schritt 5 `adb shell dumpsys battery unplug; adb shell dumpsys deviceidle force-idle`, Ausgabe notieren.)
5. Power-Taste (gesperrt), Stoppuhr starten. Handy nicht berühren.
6. K2: Hauptlauf – Medienbenachrichtigung bei kurzem Einschalten des Sperrbildschirms nach 15 min bzw. beim Verstummen (Sichtprüfung, Bildschirm nur einschalten, nicht entsperren); Diagnose-Variante – bei 5, 10, 15 min `adb shell dumpsys activity services org.mozilla.firefox | grep -i -E "media|isForeground"`.
7. Zeitpunkt des Verstummens notieren (K1), Abbruch nach 15 min.
8. Entsperren: Popup-Status/Fehlertext (K3), Player-Tab-Konsole (about:debugging → Gerät → Tab `player.html`), letzter gehörter Absatz vs. Absatz nach Play im Popup (K5).
9. `adb shell pkill logcat; adb pull /data/local/tmp/sr20.log ~/sr20-<engine>-<vorher|nachher>.log`; auswerten: `grep -iE "MediaSession|MediaControl|AudioFocus|lowmemorykiller|Killing|ANR|<PIDs>"` → K3; dabei unterscheiden: **Netzfehler** (Popup/Konsole „NetworkError“/fetch) vs. **Prozess/Audio beendet** (Kill, Tab neu geladen, Player-Tab weg). `adb shell dumpsys battery reset; adb shell dumpsys deviceidle unforce`.

**P2 – Sperrbildschirm-Steuerung:** (1) während Wiedergabe sperren, Sperrbildschirm einschalten: Pause, Play, Vor, Zurück. Je Aktion: sichtbar? wirkt? Popup-Status nach Entsperren stimmt? → K4 (n/4). (2) Media-Benachrichtigung in der Statusleiste: Titel/Website korrekt? (3) Pause, 3 min warten (Bildschirm aus), dann Sperrbildschirm an: Steuerung noch da, Play wirkt? → K4b.

**P3 – Desktop (Firefox Linux, Add-on temporär):** (1) Artikel vorlesen; Medientaste Play/Pause (bzw. `playerctl play-pause`, falls installiert) → Ton? Popup-Status? Vor/Zurück per `playerctl next/previous`. (2) Popup Play/Pause/Vor/Zurück, Steuerleiste, Highlight wie vorher (Smoke). (3) Pause > 20 s → Player-Tab zeigt kein Lautsprecher-Symbol mehr (Stille aus). (4) Autoplay-Fall: `about:preferences` → Autoplay „Audio und Video blockieren“, Player-Tab schließen, neu vorlesen → Freigabe-Dialog **mind. 5 s offen lassen** (deckt das 2-s-PLAYING-Fenster), dann „Erlauben“, danach Wiedergabe; Chunk-Wechsel ohne Aussetzer wie vorher (Lautsprecher-Symbol am Player-Tab durchgehend). Einstellung danach zurücksetzen. → K6.

### Schritt 1: `js/document.js` – Getter für Doc-Info

- [x] erledigt
- **Aktion:** UPDATE · **Datei:** `js/document.js` · **Zeilen:** nach 156 (`this.getResumeUrl`)
- **Umsetzen:** `this.getInfo = () => info;` (liefert `undefined`, solange `ready` offen; bei TabSource `{url, title, lang, canSeek, detectedLang}`, bei SimpleSource `{lang}`).
- **Muster:** `js/document.js:154-156`
- **Falle:** Objekt wird von `read()` mutiert (`detectedLang`) – nur lesen, nicht verändern.
- **Prüfen:** `node --check js/document.js`

### Schritt 2: `js/player.js` – Media Session (Baustein A)

- [x] erledigt
- **Aktion:** UPDATE · **Datei:** `js/player.js` · **Zeilen:** neuer Block nach dem Leseposition-Intervall (nach 316), Aufrufe in `openDoc`/`closeDoc` (256-273)
- **Umsetzen:**
  1. Guard: `const mediaSession = navigator.mediaSession` (fehlt → alles No-op).
  2. Handler einmalig registrieren, jeweils in `try/catch` (unbekannte Aktion wirft `TypeError`):
     `play → resume()`, `pause → pause()`, `stop → stop()`, `nexttrack → forward()`, `previoustrack → rewind()`; jeweils als `Promise.resolve().then(fn).catch(console.error)` – `Doc.forward/rewind` (`js/document.js:369-388`) liefern im Erfolgsfall `undefined`, ohne Doc ein Reject; `stop()` liefert `true`.
  3. `syncMediaSession()` (async, try/catch):
     - kein `activeDoc` → `playbackState = "none"`, `metadata = null`, gemerkter Metadaten-Schlüssel zurücksetzen.
     - sonst `state = await activeDoc.getState()` → `PAUSED` → `"paused"`, sonst (`LOADING`/`PLAYING`) → `"playing"`.
     - Metadaten nur setzen, wenn sich `info.url + "\n" + info.title` ändert: `title: info.title || extName`, `artist: hostname(info.url)` (via `new URL(...).hostname`, nur bei `http(s):`, sonst `""`), `album: extName`, `artwork: [{src: brapi.runtime.getURL("img/icon.png"), sizes: "128x128", type: "image/png"}]`. `extName = brapi.i18n.getMessage("extension_name")`.
  4. Takt: `setInterval(syncMediaSession, 1000)` und zusätzlich direkt aufrufen am Ende von `openDoc`, `closeDoc`, `pause`, `resume` (sofortige Rückmeldung, ohne auf den Takt zu warten; bei `pause`/`resume` nach dem Promise: `.finally(() => { syncMediaSession() })` am zurückgegebenen Promise – nicht auf den Sync warten, Rückgabewert/Fehler unverändert lassen).
- **Muster:** `js/player.js:278-292` (Intervall), `js/document.js:154-156`
- **Falle:** `activeDoc.getInfo()` ist bis `ready` `undefined` → Metadaten erst im nächsten Takt. `pause()`/`resume()` sind Message-Handler – Rückgabewert (Promise) muss erhalten bleiben. Kein `positionState`.
- **Prüfen:** `node --check js/player.js`; Desktop P3 (K6); danach Gerät P1 (GT) + P2 → K1/K2/K4 „nach A“ notieren.

### Schritt 3: `js/player.js` – Silence-Track durchgehend (Baustein B)

- [x] erledigt
- **Aktion:** UPDATE · **Datei:** `js/player.js` · **Zeilen:** in `syncMediaSession` bzw. daneben, `closeDoc` (266-273), `requestAudioPlaybackPermission` (380-408)
- **Umsetzen:** Modul-Variable `audioUnlocked = false`. In `requestAudioPlaybackPermission` (`js/player.js:385-408`): `granted = request().then(() => { audioUnlocked = true })` vor dem bestehenden `.catch(...)` – Freigabe gilt pro Tab und bleibt (wie `granted`). Im 1-s-Takt aus Schritt 2 (Zustand dort ohnehin abgefragt): wenn `audioUnlocked` und Zustand `LOADING`/`PLAYING` → `getSilenceTrack().start()`. In `closeDoc` (im `if (activeDoc)`-Zweig): `getSilenceTrack().stop()`. Pause: nichts extra (der Auslauf in `playAudioHere` stoppt nach 15 s). Unabhängig davon, ob `navigator.mediaSession` existiert (Guard aus Schritt 2 nicht für B).
- **Muster:** `js/defaults.js:966-1004` (`start` idempotent, bricht STOPPING ab)
- **Falle:** Silence-Track ist `lazy`-Singleton pro Dokument → Player und Content-Script (`fixBtSilenceGap`, `js/content.js:112-125`) haben getrennte Instanzen, kein Konflikt. Bei `PAUSED` darf B nicht starten, sonst läuft Stille bei Pause endlos. Ohne `audioUnlocked` hängt der Track bei Autoplay-Sperre in PLAYING ohne Ton (§6); Zustand „PLAYING“ ist dafür kein Ersatz (2-s-Fenster in `isLoading$`).
- **Prüfen:** `node --check js/player.js`; Desktop P3 (3) und (4); Gerät P1 GT + Supertonic → K1/K2/K3 „nach A+B“.

### Schritt 4: Entscheidung nach Messung

- [x] erledigt
- **Umsetzen:**
  - K1 ≥ 15 für GT und Supertonic → weiter mit Schritt 5.
  - B ohne messbaren Unterschied zu „nach A“ (K1/K2 gleich, auch Supertonic) → B wieder entfernen (Prinzip 4), in Umsetzungsbericht notieren.
  - K1 < 15 nach A+B → **stoppen**, Messbefund (K2/K3, Logauszug) an Lucas; keine Fixes aus §7 ohne neuen Plan.
- **Prüfen:** Entscheidung + Zahlen im Umsetzungsbericht.

### Schritt 5: Abnahme

- [x] erledigt
- **Umsetzen:** P1 (GT, Supertonic), P2, P3 auf dem Endstand; §4 „Nachher“ im Umsetzungsbericht.
- **Prüfen:** DoD §10.

## 14. Prüfungen

| Prüfung | Befehl / Protokoll | Sichert ab |
| --- | --- | --- |
| Syntax | `node --check js/player.js js/document.js` | — |
| Paket | `bash tools/build.sh` | XPI baut |
| Lint | `npx --yes web-ext lint -s . --ignore-files 'tools/**' 'docs/**'` | AMO-Validierung |
| Verhalten Android | P1, P2 | K1–K5 |
| Verhalten Desktop | P3 | K6, Desktop unverändert |

## 15. Umfang

2 Dateien (`js/player.js` ~45 Zeilen, `js/document.js` 1 Zeile). Kein Manifest, keine Permission, keine Locales. Regressionsrisiko Desktop: Medientasten wirken jetzt aufs Vorlesen; Stille läuft zusätzlich während des ersten Ladens (unhörbar).

## Gegenlese

| Runde | Version | Urteil | Wichtigste Befunde |
| --- | --- | --- | --- |
| 1 (Opus) | v1 | No-Go | B vor Autoplay-Freigabe hängt Track auf (→ Schranke erstes PLAYING); USB verhindert Doze (→ battery unplug + force-idle, Log auf Gerät); Install-Weg Android (→ web-ext run, Offener Punkt 4); lange Pause (→ K4b, Offener Punkt 3); Abgrenzung fixBtSilenceGap; forward/rewind ohne Promise; LOW: stop-Handler, logcat-PID, finally, embedded player, Zeile popup.js — alle eingearbeitet |
| 2 (Sonnet, Delta) | v2 | No-Go | Schranke „erstes PLAYING“ greift nicht (isLoading$ meldet 2 s PLAYING vor Freigabe) → an Freigabe-Promise gebunden; force-idle kappt Netz für GT → echter Lauf ohne Kabel maßgeblich, Netz vs. Kill unterscheiden; `--android-device`; popup.js:145; Reihenfolge P1 — eingearbeitet |
| 3 (Sonnet, Delta) | v3 | Go | nur LOW: Engines ohne playAudio / tabs.update-Fehler → bekannte Grenze in §6 |

## Umsetzungsbericht

**Datum:** 2026-11-18 · Gerät: Pixel 7a, Android 17, Firefox 160 · Desktop: Firefox 153 ESR (Linux)

**Baseline-Befund (Ursache, gemessen):** Firefox Android legt pro Chunk eine eigene Android-MediaSession an und beendet sie am Chunk-Ende. Nach Sperre wird der Neustart des Medien-Foreground-Service abgelehnt (`Background started FGS: Disallowed … startForeground() not allowed`) → keine Benachrichtigung, Firefox gedrosselt, Ton stoppt nach ~35 s; weiter erst nach Einschalten. Der stumme Silence-Track hielt die Session nicht (Gecko zählt unhörbare Medien nicht). → Hypothese 1 bestätigt; kein Netzfehler, kein Prozess-Kill.

| Aspekt | Plan | Tatsächlich | Grund |
| --- | --- | --- | --- |
| Reihenfolge Messung | Baseline P1–P3 komplett, dann A, dann B | Baseline GT P1+P2, dann A (GT, Supertonic), dann A+B (Supertonic) | Baseline zeigte Ursache eindeutig in einem Lauf; Lucas wählte nach Befund „Experiment“; Supertonic-Baseline ohne Fix entfiel (gleicher Mechanismus, A allein schon K1 < 15) |
| Rolle Baustein B | Keepalive für Medium-Kennung | hält Android-CPU/Audio-Stream wach, während Supertonic den nächsten Chunk synthetisiert | ohne B (nur A) Supertonic-Stillstand nach 12 min: Silence-Track lief 15 s nach Chunk-Ende aus, nächste Synthese hing bis Bildschirm an |
| `audioUnlocked` | im `.then` nach `request()` | direkt nach erfolgreichem `playSilence()` in `request()` | Review: Fehler beim Tab-Rückwechsel hätte Keepalive für die Sitzung abgeschaltet |
| B bei Pause | nichts extra (Auslauf in `playAudioHere`) | Sync ruft bei PAUSED `getSilenceTrack().stop()` | Review: Pause während Laden lief sonst endlos Stille (kein `finalize`) |
| `play`-Handler | `resume()` | nur wenn Doc PAUSED | Review: `Doc.play()` während Laden startet zweites `readCurrent` |
| Leerlauf-Sync | jede Sekunde `none`/`null` setzen | nur bei Änderung | Review: unnötige Writes |
| Artwork `sizes` | 128x128 | 640x640 | tatsächliche Größe von `img/icon.png` |
| Firefox-Prozessnamen | `:tabN` | `:sandboxed_tab_…` | Firefox 160 |
| Testbuild ohne Kabel (Offener Punkt 4) | web-ext run | web-ext run, Prozess nach Installation hart beenden | sonst stoppt web-ext beim Kabel-Abziehen Firefox |

| KPI | Vorher (AMO 3.4.0) | Nachher (A+B) |
| --- | --- | --- |
| K1 GT (min gesperrt) | ~0,6 (Ton bis 35 s nach Sperre) | ≥ 16 (nur A gemessen; B ändert GT nicht, s. u.) |
| K1 Supertonic | – (nicht gemessen) | ≥ 23 (nur A: 12) |
| K2 Benachrichtigung / FGS | nein, FGS-Neustart „Disallowed“ je Chunk | ja, eine Session durchgehend, 0× Disallowed |
| K3 Art des Stopps | Drosselung (kein FGS), kein Netzfehler/Kill | kein Stopp |
| K4 Sperrbildschirm Play/Pause/Vor/Zurück | 0/4 (keine Karte) | 4/4, Popup-Status stimmt |
| K4b Play nach 3 min Pause | – | ja |
| K5 Fortsetzen nach Stopp | Wiedergabe lief nach Entsperren selbst an gleicher Stelle weiter | n/a (kein Stopp) |
| K6 Desktop Medientasten (MPRIS) | – | Pause/Play/Next/Previous wirken, Popup-Status stimmt, Metadaten Titel/Website/Add-on |

| Syntax/Build/Lint | Verhalten | Silent-Failure | Review |
| --- | --- | --- | --- |
| ✓ / ✓ / 0 Fehler (12 Warnungen = master) | Android P1 (GT, Supertonic), P2, Endstand-Kurzcheck; Desktop P3 (1)–(3) | keine neuen Befunde mit Handlungsbedarf | 2 Runden, keine Blocker/High offen |

Nicht gemessen: GT-Dauerlauf mit A+B (GT zum Testzeitpunkt „temporarily unavailable“; B wirkt nur in Ladepausen und ändert an der GT-Wiedergabe nichts); P3 (4) Autoplay-Dialog erschien bei „Audio und Video blockieren“ nicht (Extension-Seite nicht blockiert) → Schranke nicht auslösbar, Logik unverändert wie geplant.

Entschieden vom Agenten (Umsetzung):

| Entscheidung | Verworfen | Warum | Prinzip |
| --- | --- | --- | --- |
| Lock-Screen-`play` nur bei PAUSED | immer `resume()` | doppeltes Lesen bei Play während Laden (z. B. BT-Headset) | 3 Funktion |
| Bekannte Grenze: Pause vom Sperrbildschirm, während ein Chunk noch lädt, kann die Medienkarte entfernen (Firefox setzt Session auf NONE); Fortsetzen dann über Popup | Audio-Element über die Ladephase halten | Umbau der Chunk-Wiedergabe, selten (einmal beobachtet, nicht reproduzierbar) | 4 Einfachheit |

Behobene Review-Befunde: Stille läuft bei Pause während Laden endlos; `play` während Laden → zweites `readCurrent`; `audioUnlocked` hing am Tab-Rückwechsel; Leerlauf-Writes.
Nicht behoben (Grund): Pause ohne `activeSpeech` wirkungslos (bestehendes Doc-Verhalten, Popup gleich); Silence-State-Machine erkennt abgelehntes/extern pausiertes `play()` nicht (bestehender Code `defaults.js`, durch `audioUnlocked` abgedeckt); Stop am Sperrbildschirm bricht laufenden Reload-Task im Background nicht ab (selten); 15 s Stille-Auslauf nach Stop (unhörbar, planmäßig); Polling statt Zustands-Events (Plan-Entscheidung); `getInfo` liefert Live-Objekt (planmäßig); PhoneTts ohne Keepalive (bekannte Grenze §6).

Offene Punkte (außerhalb #20, von Lucas notiert): Player-Tab rückt beim Start am Handy in den Vordergrund, man muss zurückwechseln; lange Chunk-Lücken bei Supertonic am Handy (bis ~40 s, CPU; #17-Rest); Supertonic-Aussprache teils schlecht.
