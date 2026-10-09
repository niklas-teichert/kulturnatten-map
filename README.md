# Kulturnatten-Karte 2026

Eine schlichte, mobile Vollbildkarte zum Programm der Kopenhagener Kulturnacht
(Kulturnatten, Freitag 09.10.2026). Statische Seite: kein Build, kein Backend, kein Tracking.

- Jede Veranstaltung ist ein kleiner farbiger Punkt (Farbe = Veranstaltungsart). Es gibt keine
  Pins und keine Cluster, damit die Karte lesbar bleibt.
- Oben stehen Filter-Chips je Veranstaltungsart (Mehrfachauswahl), dazu „All“, „★ Favorites“ und
  „Now / soon“ (läuft gerade oder beginnt innerhalb einer Stunde, Kopenhagener Zeit).
- Ein Tipp auf einen Punkt öffnet ein Blatt von unten: Titel, Ort, Adresse, Zeiten, Programmpunkte,
  Arten, Favorit, „Add to route“, offizielle Seite, Wegbeschreibung (Apple Karten auf iOS, sonst
  Google Maps).
- Eigene Route: Stopps sammeln, umsortieren, „nächster zuerst“ ab dem eigenen Standort und als
  Fußweg in Google Maps öffnen. Mehr als 9 Zwischenstopps werden in Teilstrecken geteilt.
- Der eigene Standort erscheint als blauer Punkt mit Genauigkeitskreis. Das braucht HTTPS.
- Filter, Favoriten und Route bleiben im `localStorage` des Browsers, nur auf diesem Gerät.

Externe Anfragen gehen nur an Leaflet 1.9.4 (cdnjs, mit SRI) und an die OpenStreetMap-Kacheln.

## Woher die Daten kommen

Es sind dieselben öffentlichen Daten, die auch die offizielle Karte
<https://kulturnatten.dk/en/program-map/> verwendet:

1. **WordPress-REST-API**, Beitragstyp `events` (ACF-Felder: Koordinaten, Adresse, Endzeit,
   Programmpunkte mit Zeiten, Veranstaltungsarten):
   `https://kulturnatten.dk/wp-json/wp/v2/events?lang=en&per_page=100&page=N` (3 Seiten, 217 Einträge).
2. **Die Kartenseite selbst**: die Öffnungszeit je Ort (`data-time` an jedem `<article>`; die
   API hat keine Startzeit) und die Werte des Filters „Event type“ (FacetWP-Facette
   `organizer_type`, in der API das Feld `arrangements_type`).

Übernommen werden nur Fakten: Id, Nummer, Titel, Ort, Adresse, Stadtteil, Koordinaten,
Öffnungszeit, Programmpunkte (Titel und Zeiten), Arten, „abgesagt“/„ausgebucht“ und der Link zur
offiziellen Seite. Bilder und Beschreibungen werden nicht übernommen.

Abgesagte Veranstaltungen und solche ohne Koordinaten erscheinen nicht auf der Karte. Es wird
nichts nachträglich geocodiert.

## Daten aktualisieren

```bash
python3 fetch_events.py                  # holt alles neu, schreibt events.json und meta.json
python3 fetch_events.py --cache roh/     # behält die Rohantworten und nutzt sie beim nächsten Lauf
```

Das Skript braucht nur die Python-Standardbibliothek. Es macht 4 Anfragen (Kartenseite und
3 API-Seiten) mit je einer Sekunde Pause. `meta.json` hält Quelle, Abrufzeit, Anzahl und die Arten
mit ihren Zahlen fest, zum Vergleich auch die Zahl des offiziellen Filters.

Für ein anderes Jahr müssen `EVENT_DATE` und `UTC_OFFSET` oben im Skript angepasst werden.

## Lokal ansehen

```bash
python3 -m http.server 8000
```

Danach <http://localhost:8000> öffnen. Der Standort funktioniert nur über HTTPS oder auf localhost.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css`, `app.js` | die App |
| `events.json`, `meta.json` | die Programmdaten, erzeugt von `fetch_events.py` |
| `manifest.webmanifest`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | für „Zum Home-Bildschirm“ |
