# Issue #21 – Release: AMO-Upload per web-ext sign automatisieren (release.md Schritte 5–7)

**Issue:** luc42ei/spotlight-reader#21 · **Upstream:** – · **Erstellt:** 2026-11-18
**Status:** Go · **Branch:** `feat/21-amo-submit`

# Teil A: Spec (Was/Warum)

## 1. Problem

Schritte 5–7 aus `tools/release.md` (Upload New Version, Source-Zip, Versionshinweise, Kontrolleur-Notiz) laufen manuell im AMO-Webinterface. Issue: „Ein Befehl lädt eine neue Version samt Source-Zip, Versionshinweisen und Kontrolleur-Notiz hoch; in AMO sichtbar und identisch mit dem bisherigen manuellen Ergebnis · Keine Schlüssel im Repo oder in Logs · Tag weiterhin erst nach AMO-Freigabe.“

## 2. Ursache / Ausgangslage

- Manueller Ablauf: `tools/release.md:17-37` (Schritte 5–7), Kontrolleur-Notiz per `! awk '/^## 2\./{flag=1} /^## 3\./{flag=0} flag' tools/LISTING.md` kopieren.
- `/implement-issue` Phase 5b schreibt das fest: `.claude/skills/implement-issue/SKILL.md:90` („Upload macht Lucas im AMO-Webinterface …“), `:96` („**Nie selbst bei AMO hochladen; Tag nie vor AMO-Freigabe.**“), Beschreibung `:3`, Report `:106`.
- Pakete: `tools/build.sh` → `../spotlight-reader.zip` (zippt `.` mit Excludes, cwd = Repo-Root), `tools/source-package.sh` → `../spotlight-reader-source.zip`. Beide schließen `amo.env` aus (`build.sh:23`, `source-package.sh:13`), `.gitignore:49`.
- Schlüssel: `amo.env` im Repo-Root, `chmod 600`, Variablen `JWT_ISSUER` (`user:…`) und `JWT_KEY` (64 Zeichen = JWT-Secret). Wird bisher von nichts gelesen.
- **web-ext 10.8.0** (`npx --yes web-ext@10.8.0`, im npx-Cache vorhanden, kein Eintrag in `package.json`), im Quelltext geprüft (`~/.npm/_npx/9b9ff43d0381ab42/node_modules/web-ext/lib/util/submit-addon.js`, `lib/cmd/sign.js`):
  - `sign` baut das Paket **immer selbst** aus `--source-dir`; ein fertiges Zip kann es nicht hochladen. Default-Ignore: `**/*.xpi`, `**/*.zip`, `**/.*`, `**/node_modules` (`lib/util/file-filter.js:28`). Das gebaute `../spotlight-reader.zip` enthält nichts davon (geprüft: `unzip -Z1 … | grep -E '(^|/)\.|\.(zip|xpi)$|node_modules'` leer).
  - Ablauf: Upload → Warten auf Validierung (`waitForValidation`, wirft bei `valid: false`, **keine Version angelegt**) → `PUT addon/{gecko-id}/` mit `{version: {upload, ...metadata.version}}` → danach `PATCH addon/{id}/versions/{vid}/` mit `source` (Form-Data) → bei `--approval-timeout 0` sofort Ende mit Edit-URL.
  - ID kommt aus `manifest.json` `browser_specific_settings.gecko.id` = `read-aloud-fork@lucaseichhorn` → neue Version am bestehenden Add-on.
  - Schreibt `.amo-upload-uuid` / `.web-extension-id` in den `--source-dir`.
  - Optionen auch per Umgebungsvariable `WEB_EXT_*` (`lib/program.js:15`), also `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` statt Kommandozeilenargument (nicht in `ps`).
  - Kein Probelauf-Modus.
- Versionen: `manifest.json` 3.4.0, `package.json` 3.2.5 (weicht ab; `/implement-issue` Phase 5b gleicht beim nächsten Bump an).
- `tools/LISTING.md` §2 (Zeilen 75–127): Überschrift, Hinweiszeilen 77–78 („Paste into …“, nur für Menschen), ab `**Build instructions**` (Z. 80) der eigentliche Block bis zur `---` (Z. 127) vor §3 (Z. 129); enthält Markdown (fett, Backticks, Tabelle) wie bisher beim manuellen Einfügen, UTF-8 (`—`, `→`). Länge ab „Build instructions“: 2941 Byte.

## 3. Lösung

- **Ansatz:** neues Skript `tools/amo-submit.sh` (bash, Stil wie `tools/build.sh`):
  ```
  bash tools/amo-submit.sh --dry-run
  bash tools/amo-submit.sh "<release notes, en-US>"
  ```
  1. `cd` ins Repo-Root (`$(dirname "$0")/..`).
  2. Vorbedingungen in dieser Reihenfolge (Argumente → `amo.env` → Arbeitsverzeichnis → Version), im echten Modus Abbruch, im Probelauf nur Warnung (außer Argumente/`amo.env`): Release-Notes nicht leer (außer `--dry-run`); `amo.env` vorhanden, `JWT_ISSUER` und `JWT_KEY` nicht leer; `git status --porcelain` leer außer `.claude/`; Version `manifest.json` == `package.json` (per `node -p`; Stand 3.4.0/3.2.5 weicht vor dem nächsten Bump ab).
  3. Schlüssel laden ohne Ausgabe: `amo.env` in einer Funktion zeilenweise lesen (nur die zwei Namen, kein `source` fremder Zeilen), exportieren als `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`. Kein `set -x`, kein `--verbose`.
  4. `bash tools/build.sh` und `bash tools/source-package.sh` (immer frisch → Zips = aktueller Arbeitsstand; im echten Modus dank Sauberkeitsprüfung = Commit, abgesehen von gitignorierten Dateien).
  5. Auth-/Versionsprüfung (beide Modi): JWT per `node -e` (nur `crypto`, HS256, `iss`, `jti`, `iat`, `exp` = +60 s, bewusst kürzer als web-ext, pro Aufruf neu) aus den Umgebungsvariablen; `curl -sS -H "Authorization: JWT …" https://addons.mozilla.org/api/v5/addons/addon/read-aloud-fork@lucaseichhorn/versions/v<version>/` → 404 = Versionsnummer vermutlich frei (gelöschte Nummern bleiben bei AMO gesperrt, liefern aber ggf. auch 404 – dann scheitert erst der PUT mit AMO-Meldung), 200 = schon vergeben → im echten Modus Abbruch mit Hinweis „ggf. vorheriger Teil-Upload → Developer Hub prüfen, Source/Notiz im Webinterface nachtragen“, im Probelauf Warnung; 401/403 = Schlüssel falsch → Abbruch. Token nie ausgeben (über Umgebungsvariable an `curl -H @-`/Header-Datei im Temp-Verzeichnis, nicht in argv).
  6. **`--dry-run`:** `curl -F upload=@../spotlight-reader.zip -F channel=listed …/api/v5/addons/upload/` → `uuid`; `GET …/addons/upload/<uuid>/` alle 2 s bis `processed` (max. 5 min); Ausgabe `valid`, Anzahl `errors`/`warnings`/`notices` aus `validation`. Legt **keine Version** an. Ende.
  7. **Echt:** Temp-Verzeichnis (`mktemp -d`, `trap … EXIT` räumt auf), `../spotlight-reader.zip` dorthin entpacken (= `src/`), Metadaten-JSON per `node` erzeugen: `{"version": {"release_notes": {"en-US": <notes>}, "approval_notes": <Block aus LISTING.md §2>, "compatibility": ["firefox", "android"]}}` (Android ausdrücklich, wie bisher im Webinterface angehakt); dann
     ```
     npx --yes web-ext@10.8.0 sign --channel listed --source-dir "$TMP/src" \
       --artifacts-dir "$TMP/artifacts" --amo-metadata "$TMP/meta.json" \
       --upload-source-code ../spotlight-reader-source.zip --approval-timeout 0
     ```
     Bei Fehler: Hinweis, dass ggf. eine Version ohne Source existiert → AMO Developer Hub prüfen, Source/Notiz im Webinterface nachtragen (Fallback in `release.md`).
  8. Kontrolleur-Notiz: Funktion `approval_notes()` = `awk` §2 ab Zeile `**Build instructions**` bis vor die `---` vor `## 3.` (ohne Überschrift/Hinweiszeilen/Trennlinie). Markdown bleibt wie beim bisherigen manuellen Einfügen.
- Doku: `tools/release.md` Schritte 5–7 → ein Schritt „`bash tools/amo-submit.sh "<notes>"`“, Webinterface als Fallback (bisheriger Text gekürzt erhalten). `.claude/skills/implement-issue/SKILL.md` Phase 5b: nach Freigabe „jetzt“ ruft Claude das Skript selbst auf; Regel `:96` wird „Upload nur nach Lucas' Release-Freigabe, nur per Skript; Tag nie vor AMO-Freigabe“.
- **Begründung:** `web-ext sign` ist der offizielle, gepflegte Client für Upload/Version/Source; das Entpacken des geprüften Zips als `--source-dir` sorgt dafür, dass AMO genau den Inhalt von `tools/build.sh` bekommt, ohne die Exclude-Liste zu duplizieren. Der Probelauf braucht den Upload-Endpunkt direkt, weil web-ext keinen hat (Präzisierung 2026-11-18).
- **Pflaster-Check:** (1) Absicht erfüllt: ein Befehl für 5–7, Schlüssel nur aus `amo.env`, Tag unverändert nach Freigabe. (2) kein späterer Umbau. (3) Exclude-Liste bleibt einzig in `build.sh`; Kontrolleur-Notiz bleibt einzig in `LISTING.md`.
- **Verworfen:**
  - `web-ext sign --source-dir .` mit `--ignore-files` – zweite Exclude-Liste neben `build.sh`, driftet.
  - Kompletter Upload per `curl` (Upload, PUT, PATCH Source) ohne web-ext – nachgebauter Client, mehr eigener Code; web-ext deckt den echten Pfad ab.
  - Probelauf nur per lokalem `web-ext lint` – Lucas wollte AMO-Validierung ohne Version (Präzisierung); Lint bleibt Teil von §14.

## 4. Messung (Baseline = Abnahme)

| KPI | Methode (Harness/Skript/Protokoll) | Baseline | Ziel |
| --- | --- | --- | --- |
| Manuelle Handgriffe für Schritte 5–7 | Zählung nach `release.md:17-37` (Seite öffnen, Kanal, Zip, Frage „minified“, Source-Zip, Versionshinweise, awk + Kopieren der Notiz, Absenden) | 8 | 0 (Claude ruft Skript nach Freigabe auf) |
| AMO-Validierung des aktuellen Pakets | `bash tools/amo-submit.sh --dry-run` | – (vorher nicht per Befehl möglich) | `valid: true`, 0 errors (oder einziger Fehler „Version existiert“) |
| Schlüssel in Ausgabe | Ausgabe des Probelaufs in Datei im Scratchpad; `grep -cF` auf Werte von `JWT_ISSUER`/`JWT_KEY` (Werte per Skript eingelesen, nie angezeigt) plus `grep -cE 'eyJ|Authorization'` | – | 0 Treffer |
| Versionsprüfung | Probelauf meldet „3.4.0 bereits auf AMO“ (Version existiert) | – | erkannt |
| Echter Upload | nächstes Release (z. B. #20): Version in AMO mit Source-Zip, Versionshinweisen, Kontrolleur-Notiz | manuell | per Skript, Felder identisch |

## Entschieden vom Agenten

| Entscheidung | Verworfen | Warum | Prinzip |
| --- | --- | --- | --- |
| Geprüftes Zip entpacken → `--source-dir` | `--ignore-files` mit zweiter Exclude-Liste | ein Weg für Paketinhalt | 4 |
| Probelauf per `curl` gegen `/addons/upload/` + JWT per `node` | Probelauf nur `web-ext lint` | Lucas' Wahl: AMO-Validierung ohne Version; web-ext kann das nicht | 4 (Lucas-Entscheid) |
| Versionsnummer vorab per API prüfen (beide Modi) | erst beim Upload scheitern | verhindert verbrauchte/doppelte Nummer, billig | 3/4 |
| Versionsabgleich manifest/package im Probelauf nur Warnung | harter Abbruch | aktueller Stand weicht ab (3.4.0/3.2.5), Probelauf soll trotzdem laufen | 4 |
| Kontrolleur-Notiz ab „Build instructions“, Markdown bleibt | Markdown entfernen | identisch mit bisherigem manuellem Einfügen (Akzeptanz) | 4 |
| Nur `en-US`-Versionshinweise | `de` zusätzlich | Präzisierung 2026-11-18 | – |
| Sauberkeits-/Versions-/Duplikatprüfung im Probelauf nur Warnung, im echten Modus Abbruch | immer Abbruch | Probelauf muss während der Umsetzung (unversioniertes Skript) und vor dem Bump laufen | 4 |
| Nur `.claude/` von der Sauberkeitsprüfung ausgenommen; `tools/issues/`-Pläne committet `/plan-issue` ohnehin | weitere Ausnahmen | sonst landen unversionierte Dateien im Source-Zip | 2 |
| `compatibility: ["firefox","android"]` ausdrücklich senden | weglassen | Android-Updates dürfen nicht still wegfallen | 3 |

## 5. UX

Keine Add-on-Oberfläche betroffen; nur Entwickler-Skript.

## 6. Risiken

| Risiko | Schwere | Umgang |
| --- | --- | --- |
| Endpunkt `versions/v<version>/` verhält sich anders als angenommen | mittel | Probelauf auf 3.4.0 (existiert) muss „vergeben“ melden; sonst Endpunkt korrigieren (Schritt 4) |
| PUT erfolgreich, Source-PATCH scheitert → Version ohne Source | mittel | Fehlermeldung mit Fallback-Hinweis; Lucas trägt im Webinterface nach |
| `approval_notes`-Längengrenze | niedrig | Bisher manuell gleicher Text akzeptiert; Fehler wäre beim PUT sichtbar |
| Schlüssel in Logs/argv | hoch | nur Umgebungsvariablen, kein `--verbose`/`set -x`, Grep-Prüfung (§4) |
| Probelauf-Uploads verbrauchen nichts | – | AMO-Upload ohne Version verfällt, Nummer bleibt frei |

## 7. Nicht im Umfang

| Punkt | warum nicht | Auslöser zum Nachrüsten |
| --- | --- | --- |
| Listing-Metadaten (Beschreibung, Screenshots) per API | Issue betrifft nur Versionen | Listing-Änderungen häufen sich |
| Automatischer Tag nach Freigabe (Polling) | Review dauert Tage | – |
| `README.md:110` „unlisted“ veraltet | Randbefund | nächste README-Änderung |

## 8. Geklärte Fragen

| Frage | Antwort | Datum |
| --- | --- | --- |
| Wer startet den Upload? | Claude in `/implement-issue` Phase 5b nach Lucas' Release-Freigabe | 2026-11-18 |
| Erster Test? | Probelauf (nur AMO-Validierung, keine Version); echter Test beim nächsten Release | 2026-11-18 |
| Sprachen Versionshinweise | nur `en-US` | 2026-11-18 |
| Schlüsselablage | `amo.env` im Repo-Root: `JWT_ISSUER`, `JWT_KEY` (= Secret) | 2026-11-18 |

## 9. Offene Punkte

| Nr | Punkt | Warum nicht klärbar | Folge, wenn anders |
| --- | --- | --- | --- |
| 1 | Echter Upload per web-ext erst beim nächsten Release testbar | jeder echte Lauf verbraucht eine Versionsnummer | Fehler dort → Webinterface-Fallback, Skript nachbessern |

**API-Annahmen** (AMO API v5, nicht im Repo belegbar):

| Annahme | Geprüft durch | Folge, wenn falsch |
| --- | --- | --- |
| `GET addons/addon/{guid}/versions/v<version>/` mit JWT → 200 (existiert) / 404 (nicht vorhanden) / 401 (Schlüssel falsch) | Probelauf (3.4.0 → 200) | Prüfung anpassen oder streichen; PUT meldet Duplikat ohnehin |
| `jti` im JWT schadet nicht (web-ext sendet keins) | Probelauf | weglassen |
| `POST addons/upload/` (Form: `upload`, `channel`) validiert, ohne Version anzulegen; Antwort `uuid`, Polling `processed`/`valid`/`validation` | Probelauf | Probelauf auf `web-ext lint` zurückfallen, Lucas informieren |
| Validierung einer existierenden Nummer (3.4.0) ist `valid` (Duplikat prüft erst die Versionsanlage) | Probelauf | Abnahme gilt auch, wenn einziger Fehler „Version existiert“ ist |
| `compatibility` als Liste akzeptiert; `license` wird von der Vorversion übernommen | erst beim echten Release | Version ohne Android/Lizenz → im Webinterface nachtragen, Skript korrigieren |

## 10. Definition of Done

- [ ] `bash tools/amo-submit.sh --dry-run` → Auth ok, „3.4.0 vergeben“ erkannt, AMO-Validierung `valid` mit 0 errors (oder einziger Fehler „Version existiert“)
- [ ] 0 Schlüssel-Treffer in der Probelauf-Ausgabe
- [ ] Echter Modus bricht ohne Release-Notes, bei schmutzigem Arbeitsverzeichnis und bei abweichender Version ab (lokal geprüft, ohne Upload)
- [ ] `tools/release.md` und `implement-issue` Phase 5b angepasst
- [ ] Beim ersten echten Release (Offener Punkt 1): AMO-Versionsseite zeigt Firefox **und** Android, Lizenz, Source, Notizen
- [ ] XPI-Inhalt unverändert (`unzip -Z1` vorher/nachher gleich) → Desktop/Android unberührt
- [ ] Review ohne offene Blocker/High

# Teil B: Plan (Wie)

## 11. Pflichtlektüre

| Datei | Zeilen | Warum |
| --- | --- | --- |
| `tools/release.md` | 10–40 | Ablauf, Schritte 5–7 ersetzen |
| `tools/build.sh`, `tools/source-package.sh` | alle | Stil, cwd, Ausgaben |
| `tools/LISTING.md` | 75–129 | Quelle der Kontrolleur-Notiz |
| `.claude/skills/implement-issue/SKILL.md` | 3, 84–106, 110–119 | Phase 5b, Regel, Report |
| web-ext `lib/util/submit-addon.js` (npx-Cache) | `signAddon`, `doNewAddonOrVersionSubmit`, `doFormDataPatch` | Metadaten-Format, Ablauf |

## 12. Muster zum Übernehmen

QUELLE: `tools/build.sh:1-4,25`
```bash
#!/bin/bash
set -e

OUT="../spotlight-reader.zip"
...
echo "Built: $OUT ($(du -sh "$OUT" | cut -f1))"
```

QUELLE: web-ext `lib/util/submit-addon.js` `doNewAddonOrVersionSubmit`
```js
const url = new URL(`addon/${addonId}/`, this.apiUrl);
const jsonData = { ...metaDataJson, version: { upload: uuid, ...metaDataJson.version } };
return this.fetchJson(url, 'PUT', JSON.stringify(jsonData), 'Submission failed (2)');
```
→ Metadaten-JSON: `{"version": {"release_notes": {"en-US": "…"}, "approval_notes": "…", "compatibility": ["firefox", "android"]}}`.

QUELLE: web-ext `JwtApiAuth.signJWT` – HS256, `iss` = API-Key, `iat`, `exp` (+300 s), Header `Authorization: JWT <token>`. Eigenes `node -e` setzt zusätzlich `jti` (eindeutig; web-ext sendet keins) – Annahme, siehe §9.

## 13. Schritte

### Schritt 0: Baseline messen

- [ ] erledigt
- **Umsetzen:** Handgriffe aus `release.md:17-37` zählen (8, §4); `unzip -Z1 ../spotlight-reader.zip | sort > <scratchpad>/zip-before.txt` nach `bash tools/build.sh`.
- **Prüfen:** Werte in §4, Datei existiert.

### Schritt 1: `tools/amo-submit.sh` – Grundgerüst, Vorbedingungen, Schlüssel

- [ ] erledigt
- **Aktion:** CREATE · **Datei:** `tools/amo-submit.sh`
- **Umsetzen:** Shebang/`set -euo pipefail`, Usage-Kommentar, `cd "$(dirname "$0")/.."`, Argumente (`--dry-run` | Notes), Prüfungen aus §3 Punkt 2, Funktion `load_keys` (liest nur `JWT_ISSUER=`/`JWT_KEY=` per `sed -n`, exportiert `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`), Version per `node -p "require('./manifest.json').version"`.
- **Muster:** `tools/build.sh:1-4`
- **Falle:** kein `source amo.env` (würde beliebige Zeilen ausführen und Namen nicht abbilden); Fehlermeldungen nennen Variablennamen, nie Werte.
- **Prüfen:** `bash -n tools/amo-submit.sh`; `bash tools/amo-submit.sh` ohne Argument → Usage + Exit ≠ 0; mit Notes auf aktuellem Stand → Abbruch „Arbeitsverzeichnis nicht sauber“ (Skript selbst ist unversioniert); `--dry-run` bis hierher → Warnungen „nicht sauber“ und „3.4.0 ≠ 3.2.5“, läuft weiter.

### Schritt 2: Kontrolleur-Notiz und Metadaten-JSON

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `tools/amo-submit.sh`
- **Umsetzen:** Funktion `approval_notes` (awk §2 ab `**Build instructions**`, endet vor `---`; Leerzeilen am Ende weg); `node -e` schreibt `meta.json` aus `process.argv`/stdin (UTF-8, `JSON.stringify`).
- **Falle:** Notes nicht in Shell-String interpolieren (Anführungszeichen) → über argv/stdin an `node`.
- **Prüfen:** Funktion isoliert aufrufen: `bash -c 'source <(sed -n "/^approval_notes()/,/^}/p" tools/amo-submit.sh); approval_notes' | sed -n '1p;$p'` → erste Zeile `**Build instructions**`, letzte Zeile Ende des WASM-Absatzes; JSON-Erzeugung ebenso isoliert mit Test-Notes `He said "hi" — ok` → `node -e` parst, Notes unverändert.

### Schritt 3: JWT, Auth-/Versionsprüfung

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `tools/amo-submit.sh`
- **Umsetzen:** Funktion `amo_auth_header` → schreibt `Authorization: JWT <token>` in `$TMP/auth.hdr` (`chmod 600`), Token per `node -e` aus `process.env`; `curl -sS -o /dev/null -w '%{http_code}' -H @"$TMP/auth.hdr" …/versions/v$VERSION/` → 404 weiter, 200 → im echten Modus Abbruch mit Hinweis „ggf. vorheriger Teil-Upload → Developer Hub prüfen, Source/Notiz im Webinterface nachtragen“, im Probelauf Warnung; 401/403 Abbruch „Schlüssel prüfen (amo.env)“, sonst Abbruch mit Code.
- **Falle:** JWT läuft nach 60 s ab → vor jedem API-Aufruf neu erzeugen; `jti` zufällig (`crypto.randomUUID()`).
- **Prüfen:** `bash tools/amo-submit.sh --dry-run` meldet für 3.4.0 „vergeben“ (Warnung) und läuft weiter.

### Schritt 4: Probelauf `--dry-run`

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `tools/amo-submit.sh`
- **Umsetzen:** Versionsprüfung im Probelauf nur Warnung; Upload `curl -sS -H @auth.hdr -F "upload=@../spotlight-reader.zip" -F channel=listed https://addons.mozilla.org/api/v5/addons/upload/`; `uuid` per `node -p`; Polling bis `processed` (2 s, max. 150 Versuche, Header jeweils neu); Ausgabe `valid`, `errors`, `warnings`, `notices`; Exit ≠ 0 bei `valid: false` mit Fehlermeldungen (`validation.messages[].message` der Typ-`error`-Einträge).
- **Falle:** Antworten nur über `node` parsen (kein `jq` installiert? → `command -v jq` nicht voraussetzen).
- **Prüfen:** `bash tools/amo-submit.sh --dry-run 2>&1 | tee <scratchpad>/dry-run.log` → `valid: true`, 0 errors (oder einziger Fehler „Version existiert“); Schlüssel-Grep auf Log (§4) = 0.

### Schritt 5: Echter Modus per web-ext

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `tools/amo-submit.sh`
- **Umsetzen:** `mktemp -d` + `trap 'rm -rf "$TMP"' EXIT` (gilt für alle Modi, früh anlegen); `unzip -q ../spotlight-reader.zip -d "$TMP/src"`; `meta.json`; `npx --yes web-ext@10.8.0 sign …` wie §3; bei Fehler Hinweis auf Fallback; bei Erfolg: „Eingereicht: Version X, Review läuft bei AMO; Tag erst nach Freigabe“ + Edit-URL (`https://addons.mozilla.org/developers/addon/read-aloud-fork-le/versions`).
- **Falle:** keinen `--verbose`; `--api-key`/`--api-secret` **nicht** als Argumente.
- **Prüfen:** `bash -n`; echter Upload **nicht** ausführen. Abbruchpfade, jeweils vor jedem Netzaufruf: ohne Notes; Arbeitsverzeichnis unsauber (aktueller Zustand). Versionsabweichung: Prüffunktion isoliert aufrufen (wie Schritt 2) → Abbruch im echten Modus; Reihenfolge Sauberkeit → Version per Lesen belegen.

### Schritt 6: Doku – `tools/release.md`

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `tools/release.md` · **Zeilen:** 17–37
- **Umsetzen:** Schritte 5–7 → „5. `bash tools/amo-submit.sh "<release notes>"` (builds both zips, checks version/keys, uploads listed version with source zip, en-US release notes and reviewer notes from LISTING.md §2; `--dry-run` = AMO validation only). Keys in `amo.env` (`JWT_ISSUER`, `JWT_KEY`), never committed.“ Fallback-Abschnitt „Manual upload (fallback)“ mit dem bisherigen Webinterface-Text (gekürzt, awk-Zeile bleibt). Schritte 3/4 entfallen als eigene Schritte (Skript baut beide Zips; Hinweis im neuen Schritt); Nummerierung anpassen.
- **Prüfen:** Datei lesen, Nummerierung fortlaufend, awk-Zeile im Fallback vorhanden.

### Schritt 7: Doku – `implement-issue` Phase 5b

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `.claude/skills/implement-issue/SKILL.md` · **Zeilen:** 3, 89–96, 106, 116ff.
- **Umsetzen:** Beschreibung: „Release (Bump, AMO-Upload per Skript)“. 5b Schritt 2+3 → „`bash tools/amo-submit.sh --dry-run` (Validierung), dann `bash tools/amo-submit.sh "<notes>"` (Notes vorher im Freigabe-Dialog gezeigt)“; Fallback: bei Skriptfehler Webinterface-Anleitung wie bisher. Regel: „AMO-Upload nur nach Lucas' Release-Freigabe und nur per `tools/amo-submit.sh`; Tag nie vor AMO-Freigabe.“ Report-Zeile: „eingereicht bei AMO, wartet auf Freigabe → dann Tag“. Fehlertabelle: „amo-submit.sh scheitert → Ausgabe zeigen, Fallback Webinterface“.
- **Falle:** `.claude/` ist (noch) nicht versioniert → Änderung landet nicht im Umsetzungs-Commit; im Bericht vermerken.
- **Prüfen:** Datei lesen; keine Stelle mehr „Upload macht Lucas“.

## 14. Prüfungen

| Prüfung | Befehl / Protokoll | Sichert ab |
| --- | --- | --- |
| Syntax | `bash -n tools/amo-submit.sh` | — |
| Paket | `bash tools/build.sh`; `unzip -Z1 ../spotlight-reader.zip \| sort \| diff - <scratchpad>/zip-before.txt` | XPI unverändert |
| Lint | `npx --yes web-ext lint -s . --ignore-files 'tools/**' 'docs/**'` | AMO-Validierung lokal |
| Verhalten | `bash tools/amo-submit.sh --dry-run` (valid, Version erkannt) + Abbruchpfade aus Schritt 5 | Skript wirkt |
| Secrets | `grep -cF` der Schlüsselwerte + `grep -cE 'eyJ\|Authorization'` in `dry-run.log`; `git diff master` ohne Schlüssel | keine Leaks |

## 15. Umfang

Neu: `tools/amo-submit.sh` (~120 Zeilen). Geändert: `tools/release.md` (~25 Zeilen), `.claude/skills/implement-issue/SKILL.md` (~10 Zeilen, unversioniert). Kein Add-on-Code → Regressionsrisiko für Nutzer null.

## Gegenlese

| Runde | Version | Urteil | Wichtigste Befunde |
| --- | --- | --- | --- |
| 2 (sonnet, Delta) | v2 | Go | Schritt 3 Modusunterschied, Abnahme „0 errors“ angeglichen, Prüfreihenfolge, `exp` |
| 1 (opus) | v1 | No-Go | API-Annahmen nicht als offen markiert; Android-`compatibility`; Sauberkeitsprüfung blockiert eigene Abnahme; Teil-Upload-Hinweis; Zeilen LISTING.md |

## Umsetzungsbericht

Nach der Umsetzung ausfüllen. **Datum:** …

| Aspekt | Plan | Tatsächlich | Grund |
| --- | --- | --- | --- |

| KPI | Vorher | Nachher |
| --- | --- | --- |

| Syntax/Build/Lint | Verhalten | Silent-Failure | Review |
| --- | --- | --- | --- |

Entschieden vom Agenten (Umsetzung): „keine“ oder Tabelle (Entscheidung · Verworfen · Warum · Prinzip).

Behobene Review-Befunde, nicht behobene mit Grund:
