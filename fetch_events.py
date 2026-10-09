#!/usr/bin/env python3
"""Fetch the Copenhagen Culture Night (Kulturnatten) programme and write events.json + meta.json.

Sources (public; the same data the official map https://kulturnatten.dk/en/program-map/ uses):
  1. WordPress REST API, post type "events" (ACF fields: coordinates, address, times, types):
     https://kulturnatten.dk/wp-json/wp/v2/events?lang=en&per_page=100&page=N
  2. The official map page itself: venue opening hours per event (data-time on each <article>)
     and the "Event type" filter of the map (FacetWP facet "organizer_type").

German titles: translations_de.json (original title -> German) is applied if present. Titles that
are new or changed since the translation stay in the original language (title == title_orig).

Python stdlib only. Usage:
  python3 fetch_events.py                 # fetch and write events.json / meta.json next to this script
  python3 fetch_events.py --cache DIR     # keep raw responses in DIR and reuse them on the next run
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
import urllib.request

BASE = "https://kulturnatten.dk"
MAP_URL = BASE + "/en/program-map/"
API_URL = BASE + "/wp-json/wp/v2/events?lang=en&per_page=100&page={page}"
API_FIELDS = "&_fields=id,link,title,acf"
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/129.0 Safari/537.36 kulturnatten-map/1.0")
# Kulturnatten 2026: Friday 9 October; Copenhagen is on CEST (UTC+2) that night.
EVENT_DATE = "2026-10-09"
UTC_OFFSET = "+02:00"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
TRANSLATIONS = os.path.join(OUT_DIR, "translations_de.json")


def load_translations():
    try:
        with open(TRANSLATIONS, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def fetch(url, cache_dir, name):
    """GET url politely (one request, then a pause); with cache_dir, reuse/keep the raw response."""
    body_path = os.path.join(cache_dir, name) if cache_dir else None
    head_path = body_path + ".headers.json" if body_path else None
    if body_path and os.path.exists(body_path):
        with open(body_path, "rb") as f:
            body = f.read()
        headers = {}
        if os.path.exists(head_path):
            with open(head_path) as f:
                headers = json.load(f)
        return body, headers
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
        headers = {k.lower(): v for k, v in resp.headers.items()}
    time.sleep(1.0)
    if body_path:
        os.makedirs(cache_dir, exist_ok=True)
        with open(body_path, "wb") as f:
            f.write(body)
        with open(head_path, "w") as f:
            json.dump(headers, f)
    return body, headers


def clean(text):
    return re.sub(r"\s+", " ", html.unescape(str(text or ""))).strip()


def hhmm(value):
    value = (value or "").strip()
    return value if re.fullmatch(r"\d{2}:\d{2}", value) else None


def parse_map_page(page_html):
    """Return ({event url: "18:00-23:00"}, [(slug, label, count), ...]) from the official map page."""
    times = {}
    for m in re.finditer(r"<article\b[^>]*>", page_html):
        tag = m.group(0)
        url = re.search(r'data-url="([^"]*)"', tag)
        tm = re.search(r'data-time="([^"]*)"', tag)
        if url and tm:
            times[url.group(1).strip()] = tm.group(1).strip()
    facet = []
    m = re.search(r"window\.FWP_JSON\s*=\s*(\{.*?\});\s*</script>", page_html, re.S)
    if m:
        try:
            fwp = json.loads(m.group(1))
            select_html = fwp["preload_data"]["facets"].get("organizer_type", "")
            for opt in re.finditer(r'<option value="([^"]+)" data-counter="(\d+)"[^>]*>([^<]*)</option>',
                                   select_html):
                facet.append((opt.group(1), clean(opt.group(3)), int(opt.group(2))))
        except (ValueError, KeyError) as exc:
            print("warning: could not read the map's FWP_JSON facets:", exc, file=sys.stderr)
    return times, facet


def build_event(raw, listing_times, de):
    acf = raw.get("acf") or {}
    coords = acf.get("coordinates") or {}
    lat, lng = coords.get("lat"), coords.get("lng")
    url = raw.get("link")

    # Venue opening hours: start from the map listing (the API has none), end from the API.
    start = end = None
    listing = listing_times.get(url)
    if listing and "-" in listing:
        start, end = (hhmm(x) for x in listing.split("-", 1))
    end = hhmm(acf.get("end_time")) or end

    items = []
    for sub in acf.get("sub_arrangement") or []:
        slots = []
        if hhmm(sub.get("start_time")):
            slots.append([hhmm(sub.get("start_time")), hhmm(sub.get("end_time"))])
        for extra in sub.get("time_table") or []:
            if isinstance(extra, dict) and hhmm(extra.get("start_time")):
                slots.append([hhmm(extra.get("start_time")), hhmm(extra.get("end_time"))])
        title = clean(sub.get("title_english")) or clean(sub.get("title"))
        if title or slots:
            items.append({"title": de.get(title, title), "title_orig": title, "times": slots})

    zip_city = " ".join(p for p in (clean(acf.get("zip_code")), clean(acf.get("city"))) if p)
    address = ", ".join(p for p in (clean(acf.get("event_address")), zip_city) if p)
    try:
        lat = round(float(lat), 6)
        lng = round(float(lng), 6)
    except (TypeError, ValueError):
        lat = lng = None
    title = clean(acf.get("title_english")) or clean((raw.get("title") or {}).get("rendered"))
    return {
        "id": raw.get("id"),
        "number": clean(acf.get("assigned_area_number")) or None,
        "title": de.get(title, title),
        "title_orig": title,
        "venue": clean(acf.get("organizer_name_en")) or clean(acf.get("organizer_name")),
        "address": address,
        "area": clean(acf.get("area_name")) or None,
        "lat": lat,
        "lng": lng,
        "start": start,
        "end": end,
        "items": items,
        "types": [t for t in (clean(x) for x in acf.get("arrangements_type") or []) if t],
        "canceled": bool(acf.get("canceled")),
        "sold_out": bool(acf.get("sold_out")),
        "url": url,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", help="directory for raw responses (reused on the next run)")
    args = ap.parse_args()

    page_html, _ = fetch(MAP_URL, args.cache, "program-map.html")
    listing_times, facet = parse_map_page(page_html.decode("utf-8", "replace"))

    raw_events, page, pages = [], 1, 1
    while page <= pages:
        name = "events-page-%d.json" % page
        body, headers = fetch(API_URL.format(page=page) + API_FIELDS, args.cache, name)
        pages = int(headers.get("x-wp-totalpages", pages))
        raw_events.extend(json.loads(body))
        page += 1
    expected = headers.get("x-wp-total")

    de = load_translations()
    events = [build_event(r, listing_times, de) for r in raw_events]
    events.sort(key=lambda e: (int(e["number"]) if (e["number"] or "").isdigit() else 99999, e["title"]))

    type_counts = {}
    for e in events:
        for t in e["types"]:
            type_counts[t] = type_counts.get(t, 0) + 1
    facet_by_label = {label: (slug, count) for slug, label, count in facet}
    types = [{"type": t, "count": c,
              "map_filter_slug": facet_by_label.get(t, (None, None))[0],
              "map_filter_count": facet_by_label.get(t, (None, None))[1]}
             for t, c in sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    meta = {
        "source": MAP_URL,
        "api": API_URL.format(page="N"),
        "fetched_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "event_date": EVENT_DATE,
        "utc_offset": UTC_OFFSET,
        "count": len(events),
        "api_total": int(expected) if expected else None,
        "with_coordinates": sum(1 for e in events if e["lat"] is not None),
        "with_times": sum(1 for e in events if e["start"] and e["end"]),
        "without_type": sum(1 for e in events if not e["types"]),
        "canceled": sum(1 for e in events if e["canceled"]),
        "untranslated_titles": sum(1 for e in events for t in [e] + e["items"] if t["title_orig"] and t["title_orig"] not in de),
        "types": types,
    }

    with open(os.path.join(OUT_DIR, "events.json"), "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("%d events, %d with coordinates, %d with times, %d without type, %d event types"
          % (len(events), meta["with_coordinates"], meta["with_times"], meta["without_type"], len(types)))


if __name__ == "__main__":
    main()
