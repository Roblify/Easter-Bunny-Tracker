# 🐰 Easter Bunny Tracker

The official open-source codebase for **[easterbunnytracker.org](https://easterbunnytracker.org)** — a real-time, interactive map experience that follows the Easter Bunny as he delivers eggs and baskets around the world.

> **2026** marks the first official year of live Easter Bunny tracking. Development began in 2025.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## ✨ Features

- **Live Tracking** — The Easter Bunny's position is interpolated in real time between route stops using precise Unix timestamps
- **HUD Stats** — Live updates for status, speed (MPH or KM/H), eggs delivered, carrots eaten, and arrival estimates
- **City Info Panel** — Displays local time, population, elevation, Wikipedia link, and travel direction for the current city
- **Basket Markers** — Dropped on the map at each stop the Bunny has already visited (drawn as a GPU symbol layer, so they are correctly hidden beyond the globe's horizon)
- **Egg Animation** — A floating egg FX follows the Bunny while he is delivering
- **Cinematic Camera** — Optional side-tracking camera angle with adjustable offset and zoom
- **2D / 3D Map** — Toggle between a flat Mercator map and a 3D globe with atmosphere and star effects
- **Map Styles** — Switch between Standard and Satellite map styles
- **Streamer Mode** — Hides the viewer arrival estimate to prevent location inference on streams
- **Background Music** — Looping Easter-themed audio with autoplay fallback handling
- **Persistent Settings** — All user preferences are saved to `localStorage` automatically
- **Server-Sided Timing** — All timing is synced from a server-side API to prevent client clock manipulation

---

## 🧱 Tech Stack

- **Vanilla JavaScript** (classic scripts, no framework) — the `js/` modules share state as globals, loaded in order via `<script>` tags
- **[Mapbox GL JS](https://www.mapbox.com/)** v3 — map + globe rendering
- **[Three.js](https://threejs.org/)** r128 — the animated 3D bunny model
- **[Vite](https://vite.dev/)** — local dev server and build tooling
- **Python** — optional route-processing scripts in `tools/`

---

## 🗂️ Project Structure

```
/
├── assets/
│   ├── audio/          # Background music
│   ├── img/            # Bunny, Basket, and Egg images
│   └── 3d/             # GLB/GLTF bunny model
├── css/
│   ├── style.css       # Main tracker styles
│   └── countdown.css   # Countdown page styles
├── data/
│   ├── route.json          # The Easter Bunny's full route data
│   └── cities15000.txt     # GeoNames reference for tooling (gitignored)
├── js/
│   ├── secrets.example.js  # Token template — copy to secrets.js
│   ├── secrets.js          # Your real tokens (gitignored)
│   ├── config.js           # Constants, settings persistence, user preferences
│   ├── serverTime.js       # Server-sided timing sync (clock offset from API)
│   ├── utils.js            # Pure helpers (formatting, math, geographic)
│   ├── data.js             # Stop accessors, label builders, route loading
│   ├── tracker.js          # Segment logic — the brain of the tracker
│   ├── viewer.js           # IP-based viewer location lookup
│   ├── bunny3d.js          # Decoupled 3D bunny renderer (own canvas + WebGL context)
│   ├── main.js             # App init (Mapbox map, HUD, markers, tick loop)
│   └── countdown.js        # Countdown timer logic
├── tools/              # Python utility scripts (route processing)
├── index.html          # Pre-journey countdown page
├── tracker.html        # Main live tracker page
├── FAQ.html
├── privacy.html
├── terms.html
└── 404.html
```

---

## 🚀 Getting Started

### Prerequisites

You will need free-tier API keys for two external services:

| Service | Purpose | Sign up |
|---|---|---|
| [Mapbox](https://www.mapbox.com/) | Interactive map rendering | mapbox.com |
| [ipinfo.io](https://ipinfo.io/) | Viewer location for arrival estimate | ipinfo.io |

Both have free tiers that are sufficient for running the tracker.

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd easter-bunny-tracker
```

### 2. Add your API keys

Copy the token template and fill in your own keys:

```bash
cp js/secrets.example.js js/secrets.js
```

Then edit `js/secrets.js`:

```js
window.MAPBOX_TOKEN = "your_mapbox_token_here";
window.IPINFO_TOKEN = "your_ipinfo_token_here";
```

`js/secrets.js` is **gitignored**, so your real tokens never get committed.

> ⚠️ **These are client-side tokens.** Anyone using the deployed site can read
> them from the page source or network requests — keeping them out of git does
> **not** hide them from site visitors. Always restrict each token to your own
> domain in its provider dashboard:
> - **Mapbox:** account.mapbox.com → the token's *URL restrictions*
> - **ipinfo:** ipinfo.io → *Token settings* → *Allowed domains*
>
> For a token that must stay truly secret, proxy the request through your own
> server-side endpoint (e.g. a Cloudflare Worker) so it never reaches the browser.

### 3. Route data

The Easter Bunny's journey lives in `data/route.json`, which `config.js` loads by
default (`ROUTE_FILE`). Supply your own route there, or build one with the scripts
in [`tools/`](#️-tools). Each stop follows this structure:

```json
[
  {
    "DR": 77,
    "Unix Arrival Arrival": 1775293484,
    "Unix Arrival": 1775293500,
    "Unix Arrival Departure": 1775293501,
    "Pretty Arrival EDT 2026": "4/4/2026 5:05:00",
    "City": "London",
    "Region": "Kiribati",
    "CC": "ki",
    "Locale": "en-KI",
    "Eggs Delivered": 8396,
    "Carrots eaten": 78,
    "Latitude": 1.983726,
    "Longitude": -157.474748,
    "Population Num": 1899,
    "Population Year": 2015,
    "Elevation Meter": 3,
    "Arrival Stoppage Time": 32,
    "Timezone": "Pacific/Kiritimati",
    "Wikipedia attr": "https://en.wikipedia.org/wiki/London,_Kiribati"
  }
]
```

### 4. Run it locally

Because the tracker fetches route data via `fetch()`, it needs a local HTTP
server rather than opening the HTML files directly.

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5173)
```

Or, without Node:

```bash
python3 -m http.server 8080    # then open http://localhost:8080
```

---

## ⚙️ Configuration

Key constants in `js/config.js` can be adjusted to suit your route:

| Constant | Default | Description |
|---|---|---|
| `ROUTE_FILE` | `data/route.json` | Which route file the tracker loads |
| `BASKET_START_DR` | `77` | DR value at which basket markers begin appearing |
| `TAKEOFF_DR` | `76` | DR value for the takeoff clearance stop |
| `FINAL_DR` | `1102` | DR value of the last stop (Easter Island) |
| `LOCKED_ZOOM` | `5.2` | Map zoom during active delivery |
| `LOCKED_ZOOM_PRE` | `3.5` | Map zoom before takeoff and at the final stop |
| `MUSIC_VOLUME` | `0.2` | Background music volume (0.0 – 1.0) |
| `TIMER_API_URL` | `https://api.easterbunnytracker.org/time` | Server-side timer API endpoint |

### Understanding DR (Delivery Readiness)

The `DR` field on each stop controls the tracker's phase logic:

- **DR < 76** — Pre-journey preparation stops; no delivery stats shown yet
- **DR = 76** — Takeoff clearance stop; "lifting off" status shown briefly
- **DR ≥ 77** — Active delivery; baskets, stats, and city panel are shown
- **DR = `FINAL_DR`** — Final stop; journey complete

### How 3D Tracking Renders (`js/bunny3d.js`)

The animated GLB bunny renders on its **own transparent canvas with its own WebGL
context**, layered directly over the Mapbox canvas — it is *not* a Mapbox custom
layer. A tiny no-op "matrix probe" layer captures Mapbox's view-projection matrix
each time the map renders, which keeps the model pixel-locked to the globe.

Why it's built this way: animating a model inside a Mapbox custom layer requires
`map.triggerRepaint()`, which re-renders **every map layer** (tiles, lighting,
labels) on every animation frame. With the decoupled canvas, the map only
re-renders when the camera actually moves; the bunny animates independently at a
capped ~30 fps on a scene that costs one draw call. At stops with the camera
still, the map does **zero** GPU work.

Motion is driven by two loops:
- `tick()` (10 Hz) — segment logic, HUD, phase changes
- a smooth motion rAF loop — recomputes the bunny's exact interpolated position
  from route timestamps every frame while traveling and drives the locked camera
  at ~30 fps (drops to ~15 fps automatically on struggling devices, then offers
  a one-click switch back to 2D)

Baskets are drawn as a **Mapbox symbol layer**, not DOM markers, so they draw in a
single GPU batch and the globe correctly occludes anything past the horizon.

### Local Development Helpers (localhost only)

These flags only activate when the page is served from `localhost` / `127.0.0.1`:

| URL parameter | Effect |
|---|---|
| `?t=<unix seconds>` | Pins the clock to any moment of the journey (it advances normally from there), e.g. `tracker.html?t=1779701335` |
| `?headless=1` | Drives `requestAnimationFrame` from a timer so the page runs in hidden/automated tabs |

`window._ebDebugMap` also exposes the Mapbox map instance on localhost for console debugging.

---

## ⏱️ Server-Sided Timing API

The tracker uses a server-side timer API to prevent users from manipulating their
device clock to view the tracker early. Instead of relying on `Date.now()`, the
client fetches the current time from a server endpoint once on page load, computes
the offset between the server and the local clock, and applies that offset to all
timing calculations (`serverNow()` / `serverNowSec()`). If the API is unreachable
after retries, the tracker falls back to the local clock.

The endpoint must return the current UTC time in one of these formats:

| Format | Example |
|---|---|
| `MM/DD/YYYY HH:MM:SS` | `04/04/2026 06:00:00` |
| ISO-8601 | `2026-04-04T06:00:00Z` |
| Unix timestamp (seconds or milliseconds) | `1775280000` |

A [Cloudflare Worker](https://workers.cloudflare.com/) (free tier) is a simple way
to host this. The full walkthrough below takes you from nothing to a working
endpoint; any host that can serve the response formats above works just as well.

### Option A — Deploy with the Cloudflare dashboard (no tooling)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/).
2. Go to **Workers & Pages → Create → Create Worker**, give it a name
   (e.g. `eb-timer`), and click **Deploy**.
3. Click **Edit code**, replace the default code with the Worker below, and
   click **Deploy** again:

```js
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/time") {
      const now = new Date();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      const yyyy = now.getUTCFullYear();
      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mi = String(now.getUTCMinutes()).padStart(2, "0");
      const ss = String(now.getUTCSeconds()).padStart(2, "0");
      return new Response(`${mm}/${dd}/${yyyy} ${hh}:${mi}:${ss}`, {
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
};
```

4. Your Worker is now live at a URL like `https://eb-timer.<your-subdomain>.workers.dev`.
   The time endpoint is that URL plus `/time`.

### Option B — Deploy with Wrangler (CLI)

```bash
# 1. Install the Cloudflare CLI (or use `npx wrangler ...` without installing)
npm install -g wrangler

# 2. Log in to your Cloudflare account
wrangler login

# 3. Scaffold a Worker, paste the code above into src/index.js
wrangler init eb-timer
cd eb-timer

# 4. Deploy
wrangler deploy
```

Wrangler prints the deployed URL (e.g. `https://eb-timer.<your-subdomain>.workers.dev`);
the endpoint is that URL + `/time`.

### Verify the endpoint

```bash
curl https://eb-timer.<your-subdomain>.workers.dev/time
# -> 10/20/2026 18:42:07   (current UTC time)
```

### Point the tracker at it

Update `TIMER_API_URL` in [`js/config.js`](js/config.js) to your `/time` endpoint:

```js
const TIMER_API_URL = "https://eb-timer.<your-subdomain>.workers.dev/time";
```

Reload the tracker and check the browser console — you should see a
`[serverTime] Synced. Offset: … ms` message. If the endpoint is unreachable, the
tracker logs a warning and falls back to the device clock.

### (Optional) Use your own domain

In the Cloudflare dashboard, open the Worker → **Settings → Domains & Routes** and
add a **Custom Domain** (e.g. `api.yourdomain.com`) or a **Route**
(e.g. `api.yourdomain.com/time*`). Then set `TIMER_API_URL` to the matching URL.
This requires the domain to be managed in your Cloudflare account.

> 💡 **Lock it to your own site.** The Worker above sends
> `Access-Control-Allow-Origin: *`, which lets any site call it. To restrict it to
> your domain, read the request's `Origin` header and only return the
> `Access-Control-Allow-Origin` header for origins you allow (returning a `403`
> otherwise) — the same pattern the tracker uses for its other endpoints.

---

## 🛠️ Tools

Two Python scripts in `tools/` help you build and maintain the route. Both operate
on files in `data/` and are run from the **project root**.

> **Requires Python 3.9+** (they use `zoneinfo`). Download it from
> [python.org/downloads](https://www.python.org/downloads/) if needed. No extra
> packages are required — only the standard library.

A typical new-year workflow is: **refurbish** to generate a fresh timeline and add
cities, review the result, then **compiler** to fine-tune the exact start date.

### `tools/refurbish.py` — Route Refurbisher

Rebuilds an entire route from an existing `data/route.json`. Use this to generate a
new year's journey from scratch rather than hand-editing stops. It:

- **Adds new cities** — pulls ~55 real cities (configurable) from the GeoNames
  `cities15000.txt` dataset, favoring geographic/country diversity and larger
  populations, and inserts each one into the route leg where it adds the least
  extra travel distance (greedy nearest-insertion).
- **Rebuilds the timeline** — fits all delivery stops into a fixed **25-hour event
  window** (Easter Eve 5:00 AM EDT → Easter Day 6:00 AM EDT), distributing travel
  time between stops proportionally to the distance of each leg. The pre-delivery
  narrative (DR 0–76) is scaled into a 3-hour window just before the event.
- **Recomputes stats** — eggs delivered and carrots eaten rise smoothly
  (monotonically) across the journey toward configurable final totals.
- **Re-sequences DR** — renumbers every stop's `DR` in order.

It writes the result to a **new file, `data/updated-route.json`** — your original
`route.json` is left untouched. Review it, then rename it to `route.json` to go live.

**Setup & run:**

1. Download `cities15000.zip` from
   [download.geonames.org/export/dump](https://download.geonames.org/export/dump/)
   and extract `cities15000.txt` into the `data/` folder. (This file is gitignored
   because of its size, so it won't be in a fresh clone.)
2. Adjust the configuration constants near the top of the script as needed —
   the event dates (`EVENT_START` / `EVENT_END`), `NEW_CITY_COUNT`, `MIN_POPULATION`,
   `FINAL_EGGS`, `FINAL_CARROTS`, and `RANDOM_SEED` (change it for a different set
   of cities).
3. From the project root, run:
   ```bash
   python tools/refurbish.py
   ```
4. Inspect `data/updated-route.json`. When you're happy with it, replace your route:
   ```bash
   # back up the old one first if you want to keep it
   mv data/updated-route.json data/route.json
   ```

### `tools/compiler.py` — Route Date Compiler

Shifts an existing route to a new start date **in place**, preserving each stop's
time-of-day and the per-stop offsets between arrival-arrival → arrival → departure.
Use this to re-date a finished route to the correct **Easter Eve** for a given year
without rebuilding it. Stops with `DR == 0` are ignored and left unchanged.

It reads and overwrites `data/route.json`. Before writing, it renames the existing
file to `data/DELETETHIS.json` as a backup.

**Run:**

1. Set the target date, either by editing the `--test-base-date` default in the
   script or by passing it on the command line. It must be the upcoming
   **Easter Eve** date (the day before Easter Sunday), in `YYYY-MM-DD`:
   ```bash
   python tools/compiler.py --test-base-date 2027-03-27
   ```
   Or just run it to use the script's current default:
   ```bash
   python tools/compiler.py
   ```
2. You can also point it at a specific input file (it still overwrites that file):
   ```bash
   python tools/compiler.py data/route.json
   ```
3. On success you'll see a summary like:
   ```
   Renamed existing route.json -> DELETETHIS.json
   Done.
   Original base date detected (ignoring DR 0): 2026-04-04
   Test base date: 2027-03-27 (EDT via America/New_York)
   Converted stops: 87
   Skipped DR 0 stops: 2
   ```

> The backup is named `DELETETHIS.json` and is gitignored. Once you've confirmed the
> re-dated `route.json` looks right, you can delete it.

---

## 📄 License

This project is licensed under the **GNU Affero General Public License v3.0**.
See the [LICENSE](LICENSE) file for the full text.

The AGPL is a strong copyleft license. In particular, its **network-use clause
(Section 13)** means that if you run a modified version of this software on a
server and let users interact with it over a network, you must also offer those
users the complete corresponding source code of your modified version.

---

## 💛 Support the Project

The Easter Bunny Tracker is built and maintained by **Roblify**. If you enjoy it
and want to help keep it running, consider making a donation:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/roblify)

---

## 📬 Contact

Questions, feedback, or bug reports: [support@easterbunnytracker.org](mailto:support@easterbunnytracker.org)
