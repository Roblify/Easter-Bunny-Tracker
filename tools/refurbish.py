#!/usr/bin/env python3
"""
refurbish.py — Easter Bunny Tracker Route Refurbisher (v2)

Reads data/route.json and creates data/updated-route.json with:
  - 50+ new delivery locations sourced from GeoNames (cities15000.txt)
  - All times adjusted to fit a 25-hour main tracking event:
        Easter Eve  5:00 AM EDT  ->  Easter Day  6:00 AM EDT
  - Pre-delivery narrative (DR 0-76) scaled to a 3-hour window before delivery
  - Eggs / carrots recalculated for smooth monotonic progression
  - DR numbers re-sequenced

SETUP:
  1. Download cities15000.zip from https://download.geonames.org/export/dump/
  2. Extract cities15000.txt into the data/ folder
  3. Run:  python tools/refurbish.py

Easter 2027: Sunday March 28
  Start (Easter Eve):  March 27 2027, 05:00 AM EDT  =  09:00 UTC
  End   (Easter Day):  March 28 2027, 06:00 AM EDT  =  10:00 UTC
"""

import json, math, os, sys, random
from datetime import datetime, timezone, timedelta

# ── Configuration ────────────────────────────────────────────────────────────

BASE_DIR   = os.path.join(os.path.dirname(__file__), "..")
DATA_DIR   = os.path.join(BASE_DIR, "data")
ROUTE_IN   = os.path.join(DATA_DIR, "route.json")
ROUTE_OUT  = os.path.join(DATA_DIR, "updated-route.json")
GEONAMES   = os.path.join(DATA_DIR, "cities15000.txt")

# Easter 2027 window (EDT = UTC-4)
EDT = timezone(timedelta(hours=-4))
EVENT_START = datetime(2027, 3, 27, 5, 0, 0, tzinfo=EDT)   # Easter Eve 5 AM EDT
EVENT_END   = datetime(2027, 3, 28, 6, 0, 0, tzinfo=EDT)   # Easter Day 6 AM EDT

EVENT_START_UNIX = int(EVENT_START.timestamp())
EVENT_END_UNIX   = int(EVENT_END.timestamp())
EVENT_DURATION   = EVENT_END_UNIX - EVENT_START_UNIX        # 90000s = 25h

# Pre-delivery narrative window: 3 hours before event start
PRE_DELIVERY_HOURS = 3
PRE_START_UNIX = EVENT_START_UNIX - (PRE_DELIVERY_HOURS * 3600)

# Final egg/carrot targets
FINAL_EGGS    = 6_550_000_000
FINAL_CARROTS = 58_215_839

# How many new cities to add
NEW_CITY_COUNT = 55

# Minimum population for a candidate city
MIN_POPULATION = 100_000

# Random seed for reproducibility (change this to get a different city selection)
RANDOM_SEED = 2027

# Country code -> locale mapping (common cases)
# Country code -> full country name (used for Region field)
CC_COUNTRY = {
    "AD": "Andorra", "AE": "United Arab Emirates", "AF": "Afghanistan",
    "AG": "Antigua and Barbuda", "AI": "Anguilla", "AL": "Albania",
    "AM": "Armenia", "AO": "Angola", "AQ": "Antarctica", "AR": "Argentina",
    "AS": "American Samoa", "AT": "Austria", "AU": "Australia", "AW": "Aruba",
    "AZ": "Azerbaijan", "BA": "Bosnia and Herzegovina", "BB": "Barbados",
    "BD": "Bangladesh", "BE": "Belgium", "BF": "Burkina Faso", "BG": "Bulgaria",
    "BH": "Bahrain", "BI": "Burundi", "BJ": "Benin", "BL": "Saint Barthélemy",
    "BM": "Bermuda", "BN": "Brunei", "BO": "Bolivia", "BR": "Brazil",
    "BS": "The Bahamas", "BT": "Bhutan", "BW": "Botswana", "BY": "Belarus",
    "BZ": "Belize", "CA": "Canada", "CC": "Cocos (Keeling) Islands",
    "CD": "Democratic Republic of the Congo", "CF": "Central African Republic",
    "CG": "Congo (Republic)", "CH": "Switzerland", "CI": "Côte d'Ivoire",
    "CK": "Cook Islands", "CL": "Chile", "CM": "Cameroon", "CN": "China",
    "CO": "Colombia", "CR": "Costa Rica", "CU": "Cuba", "CV": "Cape Verde",
    "CW": "Curaçao", "CX": "Christmas Island", "CY": "Cyprus", "CZ": "Czechia",
    "DE": "Germany", "DJ": "Djibouti", "DK": "Denmark", "DM": "Dominica",
    "DO": "Dominican Republic", "DZ": "Algeria", "EC": "Ecuador", "EE": "Estonia",
    "EG": "Egypt", "EH": "Western Sahara", "ER": "Eritrea", "ES": "Spain",
    "ET": "Ethiopia", "FI": "Finland", "FJ": "Fiji",
    "FK": "Falkland Islands (Islas Malvinas)", "FM": "Micronesia",
    "FO": "Faroe Islands", "FR": "France", "GA": "Gabon", "GB": "United Kingdom",
    "GD": "Grenada", "GE": "Georgia", "GF": "French Guiana", "GG": "Guernsey",
    "GH": "Ghana", "GI": "Gibraltar", "GL": "Greenland", "GM": "The Gambia",
    "GN": "Guinea", "GP": "Guadeloupe", "GQ": "Equatorial Guinea", "GR": "Greece",
    "GS": "South Georgia and the South Sandwich Islands", "GT": "Guatemala",
    "GU": "Guam", "GW": "Guinea-Bissau", "GY": "Guyana", "HK": "Hong Kong",
    "HN": "Honduras", "HR": "Croatia", "HT": "Haiti", "HU": "Hungary",
    "ID": "Indonesia", "IE": "Ireland", "IL": "Israel", "IM": "Isle of Man",
    "IN": "India", "IO": "British Indian Ocean Territory", "IQ": "Iraq",
    "IR": "Iran", "IS": "Iceland", "IT": "Italy", "JE": "Jersey",
    "JM": "Jamaica", "JO": "Jordan", "JP": "Japan", "KE": "Kenya",
    "KG": "Kyrgyzstan", "KH": "Cambodia", "KI": "Kiribati", "KM": "Comoros",
    "KN": "Saint Kitts and Nevis", "KP": "North Korea", "KR": "South Korea",
    "KW": "Kuwait", "KY": "Cayman Islands", "KZ": "Kazakhstan", "LA": "Laos",
    "LB": "Lebanon", "LC": "Saint Lucia", "LI": "Liechtenstein", "LK": "Sri Lanka",
    "LR": "Liberia", "LS": "Lesotho", "LT": "Lithuania", "LU": "Luxembourg",
    "LV": "Latvia", "LY": "Libya", "MA": "Morocco", "MC": "Monaco",
    "MD": "Moldova", "ME": "Montenegro", "MF": "Saint Martin", "MG": "Madagascar",
    "MH": "Marshall Islands", "MK": "North Macedonia", "ML": "Mali",
    "MM": "Myanmar (Burma)", "MN": "Mongolia", "MO": "Macau",
    "MP": "Northern Mariana Islands", "MQ": "Martinique", "MR": "Mauritania",
    "MS": "Montserrat", "MT": "Malta", "MU": "Mauritius", "MV": "Maldives",
    "MW": "Malawi", "MX": "Mexico", "MY": "Malaysia", "MZ": "Mozambique",
    "NA": "Namibia", "NC": "New Caledonia", "NE": "Niger", "NF": "Norfolk Island",
    "NG": "Nigeria", "NI": "Nicaragua", "NL": "Netherlands", "NO": "Norway",
    "NP": "Nepal", "NR": "Nauru", "NU": "Niue", "NZ": "New Zealand", "OM": "Oman",
    "PA": "Panama", "PE": "Peru", "PF": "French Polynesia",
    "PG": "Papua New Guinea", "PH": "Philippines", "PK": "Pakistan",
    "PL": "Poland", "PM": "Saint Pierre and Miquelon", "PN": "Pitcairn Islands",
    "PR": "Puerto Rico", "PS": "Palestine", "PT": "Portugal", "PW": "Palau",
    "PY": "Paraguay", "QA": "Qatar", "RE": "Réunion", "RO": "Romania",
    "RS": "Serbia", "RU": "Russia", "RW": "Rwanda", "SA": "Saudi Arabia",
    "SB": "Solomon Islands", "SC": "Seychelles", "SD": "Sudan", "SE": "Sweden",
    "SG": "Singapore", "SI": "Slovenia", "SJ": "Svalbard and Jan Mayen",
    "SK": "Slovakia", "SL": "Sierra Leone", "SM": "San Marino", "SN": "Senegal",
    "SO": "Somalia", "SR": "Suriname", "SS": "South Sudan",
    "ST": "São Tomé and Príncipe", "SV": "El Salvador", "SX": "Sint Maarten",
    "SY": "Syria", "SZ": "Eswatini", "TC": "Turks and Caicos Islands",
    "TD": "Chad", "TF": "French Southern and Antarctic Lands", "TG": "Togo",
    "TH": "Thailand", "TJ": "Tajikistan", "TK": "Tokelau", "TL": "Timor-Leste",
    "TM": "Turkmenistan", "TN": "Tunisia", "TO": "Tonga", "TR": "Türkiye",
    "TT": "Trinidad and Tobago", "TV": "Tuvalu", "TW": "Taiwan", "TZ": "Tanzania",
    "UA": "Ukraine", "UG": "Uganda", "US": "United States", "UY": "Uruguay",
    "UZ": "Uzbekistan", "VA": "Vatican City",
    "VC": "Saint Vincent and the Grenadines", "VE": "Venezuela",
    "VG": "British Virgin Islands", "VI": "United States Virgin Islands",
    "VN": "Vietnam", "VU": "Vanuatu", "WF": "Wallis and Futuna", "WS": "Samoa",
    "XK": "Kosovo", "YE": "Yemen", "YT": "Mayotte", "ZA": "South Africa",
    "ZM": "Zambia", "ZW": "Zimbabwe",
}

# Country code -> locale mapping (common cases)
CC_LOCALE = {
    "US": "en-US", "GB": "en", "CA": "en", "AU": "en", "NZ": "en",
    "IE": "en", "ZA": "en", "IN": "hi", "PH": "fil", "SG": "en",
    "FR": "fr", "BE": "nl", "CH": "de", "DE": "de", "AT": "de",
    "ES": "es", "MX": "es", "AR": "es", "CL": "es", "CO": "es",
    "PE": "es", "VE": "es", "EC": "es", "UY": "es", "PY": "es",
    "BO": "es", "CR": "es", "PA": "es", "GT": "es", "HN": "es",
    "SV": "es", "NI": "es", "CU": "es", "DO": "es", "PR": "es",
    "PT": "pt", "BR": "pt-BR", "IT": "it", "RO": "ro",
    "NL": "nl", "PL": "pl", "CZ": "cs", "SK": "sk", "HU": "hu",
    "HR": "hr", "RS": "sr", "BG": "bg", "GR": "el", "TR": "tr",
    "RU": "ru", "UA": "uk", "BY": "be", "KZ": "kk",
    "CN": "zh-Hans", "TW": "zh-Hant", "JP": "ja", "KR": "ko",
    "TH": "th", "VN": "vi", "ID": "id", "MY": "ms",
    "SA": "ar", "AE": "ar", "EG": "ar", "MA": "ar", "DZ": "ar",
    "TN": "ar", "IQ": "ar", "JO": "ar", "LB": "ar", "SY": "ar",
    "IR": "fa", "IL": "he", "BD": "bn", "PK": "ur", "LK": "si",
    "MM": "my", "KH": "km", "LA": "lo", "NP": "ne", "MN": "mn",
    "ET": "am", "KE": "sw", "TZ": "sw", "UG": "sw", "NG": "en",
    "GH": "en", "SE": "sv", "NO": "no", "DK": "da", "FI": "fi",
    "IS": "is", "EE": "et", "LV": "lv", "LT": "lt",
    "GE": "ka", "AM": "hy", "AZ": "az",
}

# ── Helpers ──────────────────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    R = 6371.0
    rlat1, rlon1, rlat2, rlon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def format_edt(unix_ts):
    """Format a unix timestamp as 'M/D/YYYY H:MM:SS' in EDT."""
    dt = datetime.fromtimestamp(unix_ts, tz=EDT)
    return f"{dt.month}/{dt.day}/{dt.year} {dt.hour}:{dt.minute:02d}:{dt.second:02d}"


def find_best_insert(existing_stops, new_lat, new_lon):
    """
    Find the index in the existing delivery list where inserting a new stop
    adds the least extra distance (greedy nearest-insertion).
    Returns the index to insert BEFORE.
    """
    best_idx = 1
    best_cost = float("inf")
    for i in range(1, len(existing_stops)):
        prev = existing_stops[i - 1]
        curr = existing_stops[i]
        d_prev_new  = haversine_km(prev["Latitude"], prev["Longitude"], new_lat, new_lon)
        d_new_curr  = haversine_km(new_lat, new_lon, curr["Latitude"], curr["Longitude"])
        d_prev_curr = haversine_km(prev["Latitude"], prev["Longitude"],
                                   curr["Latitude"], curr["Longitude"])
        cost = d_prev_new + d_new_curr - d_prev_curr
        if cost < best_cost:
            best_cost = cost
            best_idx = i
    return best_idx


# ── GeoNames loader ─────────────────────────────────────────────────────────

def load_geonames(path):
    """
    Parse cities15000.txt (tab-separated, no header).

    GeoNames columns:
      0  geonameid       6  feature class   12 admin3       17 timezone
      1  name            7  feature code    13 admin4       18 modification date
      2  asciiname       8  country code    14 population
      3  alternatenames  9  cc2             15 elevation
      4  latitude        10 admin1 code     16 dem
      5  longitude       11 admin2 code
    """
    cities = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 19:
                continue
            try:
                pop = int(cols[14]) if cols[14] else 0
                lat = float(cols[4])
                lon = float(cols[5])
                elev = int(cols[15]) if cols[15] else int(cols[16]) if cols[16] else 0
            except (ValueError, IndexError):
                continue

            cities.append({
                "name":       cols[1],
                "asciiname":  cols[2],
                "cc":         cols[8],
                "lat":        lat,
                "lon":        lon,
                "population": pop,
                "elevation":  elev,
                "timezone":   cols[17],
                "admin1":     cols[10],
            })
    return cities


def pick_new_cities(geonames, existing_names, count, rng):
    """
    Select `count` cities from GeoNames that aren't already in the route.

    Strategy:
      1. Filter to cities with population >= MIN_POPULATION
      2. Remove any whose name (case-insensitive) matches an existing stop
      3. Group by country, then pick cities to maximize geographic diversity:
         - Weight each country by how many cities it has in the pool
         - Preferentially pick from underrepresented countries
         - Within a country, prefer larger cities
    """
    # Filter candidates
    candidates = [
        c for c in geonames
        if c["population"] >= MIN_POPULATION
        and c["name"].lower().strip() not in existing_names
        and c["asciiname"].lower().strip() not in existing_names
    ]

    if len(candidates) < count:
        print(f"  Warning: only {len(candidates)} candidates available (wanted {count})")
        count = len(candidates)

    # Group by country
    by_country = {}
    for c in candidates:
        by_country.setdefault(c["cc"], []).append(c)

    # Sort each country's cities by population (descending)
    for cc in by_country:
        by_country[cc].sort(key=lambda c: c["population"], reverse=True)

    # Round-robin pick: cycle through countries, taking the top remaining city
    # Shuffle country order for variety
    countries = list(by_country.keys())
    rng.shuffle(countries)

    selected = []
    selected_names = set()
    round_num = 0

    while len(selected) < count:
        picked_any = False
        for cc in countries:
            if len(selected) >= count:
                break
            pool = by_country[cc]
            if round_num < len(pool):
                city = pool[round_num]
                # Avoid near-duplicate names (e.g. "Springfield" in multiple countries)
                if city["name"].lower() not in selected_names:
                    selected.append(city)
                    selected_names.add(city["name"].lower())
                    picked_any = True
        round_num += 1
        if not picked_any:
            break  # exhausted all pools

    return selected


def geonames_to_stop(city):
    """Convert a GeoNames city dict to a route stop dict."""
    cc = city["cc"].lower()
    locale = CC_LOCALE.get(city["cc"], "en")
    region = CC_COUNTRY.get(city["cc"], city["cc"])
    wiki = None  # no Wikipedia link for auto-generated entries

    return {
        "DR": 0,
        "Unix Arrival Arrival": 0,
        "Unix Arrival": 0,
        "Unix Arrival Departure": 0,
        "Pretty Arrival EDT 2026": "",
        "City": city["name"],
        "Region": region,
        "CC": cc,
        "Locale": locale,
        "Eggs Delivered": 0,
        "Carrots eaten": 0,
        "Latitude": city["lat"],
        "Longitude": city["lon"],
        "Population Num": city["population"],
        "Population Year": 2024,
        "Elevation Meter": city["elevation"],
        "Arrival Stoppage Time": 0,
        "Timezone": city["timezone"],
        "Wikipedia attr": wiki,
        "": None,
    }


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # Check for GeoNames data
    if not os.path.isfile(GEONAMES):
        print("ERROR: GeoNames data not found!")
        print(f"  Expected: {os.path.abspath(GEONAMES)}")
        print()
        print("To fix this:")
        print("  1. Download cities15000.zip from https://download.geonames.org/export/dump/")
        print("  2. Extract cities15000.txt into the data/ folder")
        print("  3. Run this script again")
        sys.exit(1)

    # Load original route
    with open(ROUTE_IN, "r", encoding="utf-8") as f:
        route = json.load(f)

    # Split into pre-delivery (DR 0-76) and delivery (DR >= 77)
    pre_delivery = []
    delivery = []

    for s in route:
        dr = s["DR"]
        if isinstance(dr, int) and dr < 77:
            pre_delivery.append(s)
        else:
            delivery.append(s)

    # Separate the last stops (return to workshop + completion)
    final_stops = []
    while delivery and delivery[-1]["City"].startswith("Easter Bunny"):
        final_stops.insert(0, delivery.pop())

    print(f"Original: {len(pre_delivery)} pre-delivery + {len(delivery)} delivery + {len(final_stops)} final stops")

    # ── Load GeoNames and pick new cities ────────────────────────────────────
    print(f"Loading GeoNames data from {GEONAMES}...")
    geonames = load_geonames(GEONAMES)
    print(f"  Loaded {len(geonames):,} cities from GeoNames")

    existing_names = {s["City"].lower().strip() for s in delivery}
    rng = random.Random(RANDOM_SEED)

    new_cities = pick_new_cities(geonames, existing_names, NEW_CITY_COUNT, rng)
    print(f"  Selected {len(new_cities)} new cities (min pop: {MIN_POPULATION:,})")

    # ── Insert new cities into delivery list ─────────────────────────────────
    added = 0
    for city in new_cities:
        stop = geonames_to_stop(city)
        if stop["City"].lower().strip() in existing_names:
            continue
        idx = find_best_insert(delivery, stop["Latitude"], stop["Longitude"])
        delivery.insert(idx, stop)
        existing_names.add(stop["City"].lower().strip())
        added += 1

    print(f"  Inserted {added} new cities -> {len(delivery)} total delivery stops")

    # Show what was added
    print("\n  New cities added:")
    for city in new_cities:
        print(f"    - {city['name']} ({city['cc']}, pop {city['population']:,})")

    # ── Assign stoppage times to new stops ───────────────────────────────────
    for s in delivery:
        if s["Arrival Stoppage Time"] == 0 or s["Arrival Stoppage Time"] is None:
            s["Arrival Stoppage Time"] = rng.randint(8, 30)

    # ── Distribute time proportionally to distance ───────────────────────────
    total_stoppage = sum(s["Arrival Stoppage Time"] for s in delivery)
    travel_budget = EVENT_DURATION - total_stoppage

    if travel_budget <= 0:
        print(f"ERROR: total stoppage ({total_stoppage}s) exceeds event duration ({EVENT_DURATION}s)")
        sys.exit(1)

    # Compute leg distances
    leg_distances = [0.0]
    for i in range(1, len(delivery)):
        prev, curr = delivery[i - 1], delivery[i]
        d = haversine_km(prev["Latitude"], prev["Longitude"],
                         curr["Latitude"], curr["Longitude"])
        leg_distances.append(d)

    total_distance = sum(leg_distances)

    # Assign travel time proportional to distance, with a minimum of 20s per leg
    MIN_TRAVEL = 20
    guaranteed_travel = MIN_TRAVEL * (len(delivery) - 1)
    flex_budget = max(0, travel_budget - guaranteed_travel)

    travel_times = [0]
    for i in range(1, len(delivery)):
        frac = leg_distances[i] / total_distance if total_distance > 0 else 0
        travel_times.append(MIN_TRAVEL + int(frac * flex_budget))

    # Build delivery timestamps
    cursor = EVENT_START_UNIX
    for i, s in enumerate(delivery):
        arrival = cursor + travel_times[i]
        stoppage = s["Arrival Stoppage Time"]
        departure = arrival + stoppage

        s["Unix Arrival Arrival"] = arrival
        s["Unix Arrival"] = arrival
        s["Unix Arrival Departure"] = departure
        s["Pretty Arrival EDT 2026"] = format_edt(arrival)

        cursor = departure

    # ── Rescale pre-delivery narrative ───────────────────────────────────────
    orig_pre_start = None
    orig_pre_end = None
    for s in pre_delivery:
        if s["DR"] == 0:
            continue
        t = s["Unix Arrival Arrival"]
        if t and t > 0:
            if orig_pre_start is None or t < orig_pre_start:
                orig_pre_start = t
            if orig_pre_end is None or t > orig_pre_end:
                orig_pre_end = t

    orig_pre_duration = max(1, orig_pre_end - orig_pre_start)
    new_pre_duration = PRE_DELIVERY_HOURS * 3600

    for s in pre_delivery:
        if s["DR"] == 0:
            s["Unix Arrival Arrival"] = 0
            s["Unix Arrival"] = 0
            s["Unix Arrival Departure"] = 0
            s["Pretty Arrival EDT 2026"] = "lol"
            continue

        orig_t = s["Unix Arrival Arrival"]
        if orig_t and orig_t > 0:
            frac = (orig_t - orig_pre_start) / orig_pre_duration
            new_t = PRE_START_UNIX + int(frac * new_pre_duration)
        else:
            new_t = PRE_START_UNIX

        s["Unix Arrival Arrival"] = new_t
        s["Unix Arrival"] = new_t
        s["Unix Arrival Departure"] = new_t
        s["Pretty Arrival EDT 2026"] = format_edt(new_t)

    # ── Build final stops (return to workshop) ───────────────────────────────
    for fs in final_stops:
        fs["Unix Arrival Arrival"] = EVENT_END_UNIX
        fs["Unix Arrival"] = EVENT_END_UNIX
        fs["Unix Arrival Departure"] = EVENT_END_UNIX
        fs["Pretty Arrival EDT 2026"] = format_edt(EVENT_END_UNIX)

    # ── Combine and re-sequence DR numbers ───────────────────────────────────
    full_route = pre_delivery + delivery + final_stops

    for i, s in enumerate(full_route):
        s["DR"] = i

    # ── Recalculate eggs and carrots ─────────────────────────────────────────
    delivery_start_idx = len(pre_delivery)
    delivery_end_idx = delivery_start_idx + len(delivery) - 1

    for i, s in enumerate(full_route):
        if i < delivery_start_idx:
            s["Eggs Delivered"] = 0
            s["Carrots eaten"] = 0
        elif i <= delivery_end_idx:
            frac = (i - delivery_start_idx) / max(1, delivery_end_idx - delivery_start_idx)
            s["Eggs Delivered"] = int(frac * FINAL_EGGS)
            s["Carrots eaten"] = int(frac * FINAL_CARROTS)
        else:
            s["Eggs Delivered"] = FINAL_EGGS
            s["Carrots eaten"] = FINAL_CARROTS

    # ── Write output ─────────────────────────────────────────────────────────
    with open(ROUTE_OUT, "w", encoding="utf-8") as f:
        json.dump(full_route, f, indent=2, ensure_ascii=False)

    # ── Summary ──────────────────────────────────────────────────────────────
    first_del = delivery[0]
    last_del = delivery[-1]
    print(f"\nOutput: {os.path.abspath(ROUTE_OUT)}")
    print(f"Total stops: {len(full_route)}")
    print(f"Pre-delivery: {len(pre_delivery)} (DR 0-{len(pre_delivery)-1})")
    print(f"Delivery:     {len(delivery)} (DR {len(pre_delivery)}-{len(pre_delivery)+len(delivery)-1})")
    print(f"Final:        {len(final_stops)}")
    print(f"Window:       {EVENT_START.strftime('%b %d %Y %I:%M %p')} EDT -> {EVENT_END.strftime('%b %d %Y %I:%M %p')} EDT")
    print(f"First delivery: {format_edt(first_del['Unix Arrival Arrival'])} -- {first_del['City']}")
    print(f"Last delivery:  {format_edt(last_del['Unix Arrival Departure'])} -- {last_del['City']}")
    print(f"Final eggs: {full_route[-1]['Eggs Delivered']:,}")
    print(f"Final carrots: {full_route[-1]['Carrots eaten']:,}")


if __name__ == "__main__":
    main()
