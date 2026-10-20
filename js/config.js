/* =============================================================================
 *  Easter Bunny Tracker  -  config.js
 *
 *  Sections:
 *    1. Configuration
 *    2. Settings  (localStorage persistence)
 *    3. User Preferences  (defaults from saved settings)
 * ============================================================================= */

"use strict";


/* =============================================================================
 *  1. CONFIGURATION
 * ============================================================================= */

// API tokens are supplied by js/secrets.js (loaded before this file), which is
// gitignored so real credentials never reach the public repo. Copy
// js/secrets.example.js to js/secrets.js and fill in your own tokens.
//
// NOTE: these are CLIENT-SIDE tokens — any visitor can read them from the page
// source or network requests. Keeping them out of git does not hide them from
// users of the deployed site. The real protection is to restrict each token to
// your own domain in its provider dashboard:
//   - Mapbox:  account.mapbox.com → the token's "URL restrictions"
//   - ipinfo:  ipinfo.io → Token settings → "Allowed domains"
// For a token that must stay truly secret, proxy the request through your own
// server-side endpoint (e.g. a Cloudflare Worker) so it never reaches the browser.
const MAPBOX_TOKEN = (typeof window !== "undefined" && window.MAPBOX_TOKEN) || "";
const _IPT = (typeof window !== "undefined" && window.IPINFO_TOKEN) || "";

if (!MAPBOX_TOKEN) {
    console.error("[config] Missing MAPBOX_TOKEN. Copy js/secrets.example.js to js/secrets.js and add your tokens.");
}

const ROUTE_FILE = "data/route.json";

// Server-side timer API (returns a UTC timestamp - keeps all clients in sync)
const TIMER_API_URL = "https://api.easterbunnytracker.org/time";

// Delivery-readiness thresholds (DR values)
const BASKET_START_DR = 77;
const CITY_PANEL_MIN_DR = 77;
const TAKEOFF_DR = 76;
const PRE_STATUS_MAX_DR = 75;
const FINAL_DR = 1102;

// Other tracker variables
let speedJitter = 0;

// Fraction of each city's egg/carrot delta credited while FLYING toward it
// (deliveries over the countryside en route); the remainder accrues during
// the stop itself. 0 = counts only rise at stops, 1 = only while traveling.
const TRAVEL_STATS_SHARE = 0.6;

// Mapbox zoom levels
const LOCKED_ZOOM = 5.2;   // zoom during active delivery (DR >= 76)
const LOCKED_ZOOM_PRE = 3.5;   // zoom before DR 76 and at final stop
const UNLOCKED_MIN_ZOOM = 0.1;
const UNLOCKED_MAX_ZOOM = 16.0;

// 3D tracking camera.
// LOCKED_ZOOM is the base zoom AT THE EQUATOR; the tracker adds log2(cos(lat))
// to it so the balloon keeps the same on-screen size at every latitude (in
// Mercator a fixed-size object is ~1/cos(lat) bigger toward the poles, which
// otherwise makes him tiny near the equator and huge near the poles).
const TRACKING_3D_LOCKED_ZOOM = 11.4;
const TRACKING_3D_LOCKED_ZOOM_PRE = 6;
// Where the camera locks vertically on the model, as a fraction of the model's
// height above his feet. Low (~0.1) frames the BUNNY in the basket rather than
// the balloon above him. (0.5 would be the model's middle = the balloon.)
const TRACKING_3D_FRAME_HEIGHT_FRAC = 0.1;
// While locked in 3D the user may scroll to zoom in/out on the bunny. Keep the
// range tight so he stays framed (zoom out for context, in for a close-up) and
// the rate gentle so a single wheel notch is a small, controllable step.
// The MAX is a hard zoom-in floor: the camera enters (ends up inside) the model
// around zoom ~11, so cap below that where the whole bunny still reads on screen.
// These bound the BASE (equator) zoom the user can scroll to; the latitude
// compensation above is applied on top. MAX stays below where the camera would
// clip his feet / enter the model (~12.0 at the equator).
const TRACKING_3D_USER_ZOOM_MIN = 10;
const TRACKING_3D_USER_ZOOM_MAX = 11.7;
const TRACKING_3D_WHEEL_ZOOM_RATE = 0.002;   // zoom-levels per unit wheel delta

// Tilt from straight-down. Higher = more toward the horizon, so more sky shows
// above the bunny. Raising it also enlarges him (the look-at point sits higher,
// dollying the camera in), so the base zoom below is trimmed to keep his size.
const TRACKING_3D_PITCH = 72;

// Orbit (left-drag) pitch is clamped to this band. The max equals the designed
// pitch, so the user can only tilt DOWN from it: tilting steeper would grow the
// forward framing offset, drop the "inside the model" zoom threshold, and dolly
// the camera into the tall model. Below ~25° the 3D look flattens out.
const TRACKING_3D_ORBIT_PITCH_MIN = 25;
const TRACKING_3D_ORBIT_PITCH_MAX = TRACKING_3D_PITCH;
// (zoom/altitude tuned together so the larger balloon stays framed)
const TRACKING_3D_BEARING_OFFSET = -20;
const TRACKING_3D_MODEL_SCALE = 90;
// Degrees to rotate the model so its front faces the direction of travel.
// Tune per model (the balloon/bunny's native forward differs from the old one).
const TRACKING_3D_MODEL_HEADING_OFFSET = 270;

// Zoom threshold for switching between the 3D model and the 2D sprite.
// Below this the model is too small to notice — and the projection matrix
// the 3D renderer relies on is only plain mercator at zoom >= ~6, so keep
// this above that.
const TRACKING_3D_ZOOM_THRESHOLD = 7;

// Meters above ground the bunny flies while traveling between stops. He
// eases down to ground level while delivering at a stop and lifts back off
// on departure. The model scale (4000) means the rendered bunny is huge in
// world units, so the flight altitude needs to be kilometer-scale to read
// as "airborne" at the locked zoom.
const TRACKING_3D_FLIGHT_ALTITUDE = 8000;

// Fraction of the viewport height reserved above the bunny in 3D mode, so
// the camera frames him in the lower third with the route ahead on screen
// (and clear of the HUD) instead of dead-center.
const TRACKING_3D_TOP_PADDING_FRAC = 0.10;

// Atmosphere for the 3D globe.
//   Set to null   -> no fog at all (terrain ends in a hard cutoff against space)
//   Set to {}     -> Mapbox's DEFAULT fog. Do NOT use: its color is #ffffff,
//                    which is the white haze that used to sit on the horizon.
// Fog removed entirely in 3D mode: no atmosphere/haze at all. The night-mode
// dark sky comes from the globe's own space background beyond the horizon.
const TRACKING_3D_FOG = null;

// Maximum device-pixel-ratio the map renders at on capable hardware.
// 1.0 = soft on Retina/4K, 1.5 ~= 2.25x the pixels, 2.0 = 4x. Mobile and
// low-core/low-memory devices are pinned to 1.0 regardless.
const MAX_PIXEL_RATIO = 1.5;

// Map styles
const STANDARD_STYLE = "mapbox://styles/mapbox/standard";
const SATELLITE_STYLE = "mapbox://styles/theroblify/cmmqvyxfl00as01sugspqf5d5";

// Universal fallback — stock Mapbox satellite, guaranteed to work on all devices
const FALLBACK_SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-v9";

const MUSIC_VOLUME = 0.2;


/* =============================================================================
 *  2. SETTINGS  (localStorage persistence)
 * ============================================================================= */

const SETTINGS_STORAGE_KEY = "eb_tracker_settings_v1";

function loadSettings() {
    try {
        const json = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!json) return {};
        const parsed = JSON.parse(json);
        return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
        console.warn("Failed to load settings from localStorage:", e);
        return {};
    }
}

function saveSettings(partial) {
    try {
        const next = { ...loadSettings(), ...partial };
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
        console.warn("Failed to save settings to localStorage:", e);
    }
}

// Read once on startup so preference defaults can reference it
const initialSettings = loadSettings();


/* =============================================================================
 *  3. USER PREFERENCES  (with persisted defaults)
 * ============================================================================= */

let currentStyle = (initialSettings.mapStyle === "standard" || initialSettings.mapStyle === "satellite")
    ? initialSettings.mapStyle
    : "satellite";

let speedUnitMode = initialSettings.speedUnitMode === "kmh" ? "kmh" : "mph";

let streamerModeEnabled = !!initialSettings.streamerModeEnabled;

// Legacy mapDimensionMode replaced by tracking3dEnabled in v2
let tracking3dEnabled = !!initialSettings.tracking3dEnabled;

// Derived: globe projection is tied to 3D tracking
let mapDimensionMode = tracking3dEnabled ? "3d" : "2d";

// HUD stat visibility (all enabled by default)
let showStatEggs = initialSettings.showStatEggs !== false;
let showStatCarrots = initialSettings.showStatCarrots !== false;
let showStatArrivalEstimate = initialSettings.showStatArrivalEstimate !== false;
let showStatLastSpotted = initialSettings.showStatLastSpotted !== false;
let showStatSpeed = initialSettings.showStatSpeed !== false;

// Travel trails (disabled by default)
let travelTrailsEnabled = !!initialSettings.travelTrailsEnabled;

// Bunny hop animation (disabled by default)
let bunnyHopEnabled = !!initialSettings.bunnyHopEnabled;