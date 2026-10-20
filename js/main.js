/* =============================================================================
 *  Easter Bunny Tracker  -  main.js
 *
 *  9. Application Init  (Mapbox map, HUD, markers, tick loop)
 *
 *  Dependencies (loaded via <script> before this file):
 *    config.js  - constants, settings, preferences
 *    utils.js   - pure helpers (formatting, math, geo)
 *    data.js    - data helpers, route loading
 *    tracker.js - findSegment and segment classification
 *    viewer.js  - IP-based viewer location
 *    bunny3d.js - decoupled 3D bunny renderer (own canvas + WebGL context)
 * ============================================================================= */

"use strict";

(async function init() {
    try {

        // -- Pre-journey gate --------------------------------------------------
        // Redirects anyone who visits before March 27, 2027 at 06:00 UTC back to index.html.
        // Remove or disable this once the journey is live.
        // Local development always bypasses the gate so the tracker (and the
        // ?t= time override) can be previewed before the journey is live.
        const _isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
        const PRE_JOURNEY_START_UTC_MS = Date.UTC(2027, 2, 27, 6, 0, 0);
        if (!_isLocalhost && serverNow() < PRE_JOURNEY_START_UTC_MS) {
            window.location.replace("index.html");
            return;
        }

        // The loading overlay is visible by default (see tracker.html). On any
        // early bail-out below we must take it down ourselves, or the user is
        // left staring at a loading screen that never resolves.
        function hideOverlayHard() {
            const ov = document.getElementById("loadingOverlay");
            if (ov) ov.hidden = true;
        }

        if (typeof mapboxgl === "undefined") {
            console.error("Mapbox GL JS is undefined. Make sure its script is loaded.");
            hideOverlayHard();
            return;
        }

        // -- WebGL check ------------------------------------------------------
        if (!mapboxgl.supported({ failIfMajorPerformanceCaveat: false })) {
            console.error("WebGL is not supported by this browser.");
            const el = document.getElementById("statStatus");
            if (el) el.textContent = "Your browser does not support WebGL. Please try a different browser or enable hardware acceleration.";
            hideOverlayHard();
            return;
        }

        // -- Loading overlay --------------------------------------------------

        const loadingOverlay = $("loadingOverlay");
        const loadingBarFill = $("loadingBarFill");
        let loadingProgress = 0;

        // The overlay is shown on every open (visible by default in the HTML).
        // It stays up until the tracker is genuinely usable: route + server
        // time loaded, the map's first tiles rendered, and the marker images
        // decoded — or, in the 3D delivery path, until the space-to-bunny
        // intro finishes. `readyToReveal` is the single gate: dismissLoading()
        // is a no-op until something declares the tracker ready, so none of the
        // scattered dismiss calls can reveal a half-built map early.
        let readyToReveal = false;

        function setLoadingProgress(pct) {
            loadingProgress = Math.max(loadingProgress, pct);
            if (loadingBarFill) loadingBarFill.style.width = `${loadingProgress}%`;
        }

        function dismissLoading() {
            if (!readyToReveal) return;
            if (!loadingOverlay || loadingOverlay.hidden) return;
            setLoadingProgress(100);
            setTimeout(() => {
                loadingOverlay.classList.add("fade-out");
                setTimeout(() => { loadingOverlay.hidden = true; }, 900);
            }, 200);
        }

        // Failure-safe: no matter what stalls (a hung CDN, tiles that never
        // render, a slow GLB), never trap the user on the loading screen.
        setTimeout(() => {
            if (!readyToReveal) {
                console.warn("[loading] Reveal failsafe fired — showing tracker anyway.");
                readyToReveal = true;
                dismissLoading();
            }
        }, 15000);

        // -- Boot -------------------------------------------------------------

        const statDurationEl = $("statDuration");
        if (statDurationEl) statDurationEl.textContent = "Loading...";
        $("statStatus").textContent = "Loading route\u2026";

        setLoadingProgress(5);

        // Sync server time and load route data in parallel
        const [, stops] = await Promise.all([initServerTime(), loadRoute()]);
        setLoadingProgress(20);

        // -- Mapbox setup -----------------------------------------------------

        mapboxgl.accessToken = MAPBOX_TOKEN;
        const firstStop = stops[0];

        // -- Device detection --------------------------------------------------
        // Declared before the map so pixel-ratio selection can use it.
        const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        const _isMobile = _isIOS || /Android/i.test(navigator.userAgent);

        // Render resolution. The old code hard-pinned this to 1.0 because the
        // 3D bunny forced a full-map repaint ~24×/sec, making the map
        // permanently fill-rate-bound. The renderer is decoupled now (the map
        // only draws when the camera moves), so we can afford some real
        // sharpness on capable hardware — 4K/Retina displays were rendering at
        // quarter resolution and looked noticeably soft.
        //
        // Still capped at 1.5 (not the native 2–3): 1.5² is ~2.25× the pixels
        // of 1.0, whereas 2.0 would be 4× and 3.0 a ruinous 9×. Weak/mobile
        // GPUs stay at 1.0.
        const _dpr = window.devicePixelRatio || 1;
        const _lowPower = _isMobile ||
            (navigator.hardwareConcurrency || 4) <= 4 ||
            (navigator.deviceMemory || 4) <= 4;
        const _pixelRatio = _lowPower ? 1 : Math.min(_dpr, MAX_PIXEL_RATIO);

        const map = new mapboxgl.Map({
            container: "cesiumContainer",
            style: currentStyle === "satellite" ? SATELLITE_STYLE : STANDARD_STYLE,
            center: [firstStop.Longitude, firstStop.Latitude],
            zoom: LOCKED_ZOOM,
            bearing: 0,
            pitch: 0,
            projection: "mercator",  // always start 2D; switches to globe at takeoff if 3D enabled
            pixelRatio: _pixelRatio,
            // A bigger cache means revisiting a view (orbiting back around the
            // bunny) reuses decoded tiles instead of re-fetching and
            // re-decoding them — the single most common source of visible
            // "blurry then sharp" popping. Low-power devices keep the small
            // cache to limit memory pressure.
            maxTileCacheSize: _lowPower ? 80 : 250,
            // Still no MSAA on the map context — the higher pixel ratio above
            // does more for edge quality per unit of GPU time, and the 3D
            // bunny gets its own antialiased context in bunny3d.js.
            antialias: false,
            // A short cross-fade instead of a hard pop as tiles arrive. Costs
            // a few frames only while tiles are actually loading.
            fadeDuration: _lowPower ? 0 : 120
        });

        // Expose the map for local debugging (?t= override implies localhost)
        if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
            window._ebDebugMap = map;
        }

        // -- Session state -----------------------------------------------------
        // NOTE: isLocked is declared HERE, before applyMapDimensionMode, so that
        // function can safely reference it when style.load fires early.

        let isLocked = true;

        // -- Map dimension (2D / 3D) -------------------------------------------

        function applyMapDimensionMode() {
            try {
                if (mapDimensionMode === "3d" && !_isIOS) {
                    map.setProjection("globe");
                    // NOTE: setFog({}) does NOT disable fog — it applies
                    // Mapbox's DEFAULT fog, whose color is #ffffff. That was
                    // the white haze on the horizon.
                    //
                    // Fully removing it (setFog(null)) leaves the tiles ending
                    // in a hard black cutoff, so instead we use a dark fog
                    // tuned to the night sky: no white haze, but the terrain
                    // fades into space instead of stopping dead. Set
                    // TRACKING_3D_FOG to null in config.js to remove it.
                    try { map.setFog(TRACKING_3D_FOG); } catch (e) { /* ignore */ }
                } else {
                    map.setProjection("mercator");
                    // Clear fog safely — iOS chokes on null
                    try { map.setFog({}); } catch (e) { /* ignore */ }
                    if (isLocked) {
                        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
                    }
                }
            } catch (e) {
                console.warn("[map] applyMapDimensionMode failed:", e);
            }
        }

        // -- Style fallback chain ------------------------------------------------
        // Fallback order:
        //   Standard → custom Satellite → stock Mapbox satellite
        //   custom Satellite → stock Mapbox satellite
        //   (stock Mapbox satellite is the final safety net)

        let _fallbackLevel = 0; // 0 = none, 1 = tried custom satellite, 2 = tried stock satellite

        function fallbackStyle(reason) {
            console.warn("[map] Style issue (" + reason + ") — attempting fallback. Level: " + _fallbackLevel);

            if (_fallbackLevel === 0) {
                // First fallback: try custom Satellite (or stock if already on custom satellite)
                if (currentStyle === "satellite") {
                    // Already on custom satellite — skip to stock
                    _fallbackLevel = 1;
                } else {
                    _fallbackLevel = 1;
                    currentStyle = "satellite";
                    saveSettings({ mapStyle: "satellite" });
                    if (typeof updateMapStyleButton === "function") updateMapStyleButton();
                    try { map.setStyle(SATELLITE_STYLE); return; } catch (e) {
                        console.warn("[map] Custom satellite fallback failed:", e);
                    }
                }
            }

            if (_fallbackLevel <= 1) {
                // Final fallback: stock Mapbox satellite (works on all devices)
                _fallbackLevel = 2;
                console.warn("[map] Falling back to stock Mapbox satellite style.");
                currentStyle = "satellite";
                if (typeof updateMapStyleButton === "function") updateMapStyleButton();
                try { map.setStyle(FALLBACK_SATELLITE_STYLE); } catch (e) {
                    console.error("[map] All style fallbacks exhausted:", e);
                }
            }
        }

        map.on("style.load", () => {
            applyMapDimensionMode();

            // setConfigProperty is only for Standard / Standard-Satellite component styles.
            // Skip entirely on stock styles and on iOS (where these calls can cause
            // silent rendering failures on unsupported styles).
            const isComponentStyle = currentStyle === "standard" ||
                (currentStyle === "satellite" && SATELLITE_STYLE.includes("theroblify") && _fallbackLevel < 2);

            if (isComponentStyle && !_isIOS) {
                if (currentStyle === "standard") {
                    try { map.setConfigProperty("basemap", "lightPreset", "dusk"); } catch (e) {
                        console.warn("[map] setConfigProperty lightPreset failed:", e);
                    }
                }

                // -- Hide roads (but preserve borders, labels, and admin boundaries) --
                try { map.setConfigProperty("basemap", "showRoadLabels", false); } catch (e) { /* unsupported */ }
                try { map.setConfigProperty("basemap", "showPlaceLabels", true); } catch (e) { /* unsupported */ }
                try { map.setConfigProperty("basemap", "showPointOfInterestLabels", false); } catch (e) { /* unsupported */ }
            }

            // Layer-level road hiding (works on all style types)
            try {
                const layers = map.getStyle().layers;
                for (const layer of layers) {
                    const id = (layer.id || "").toLowerCase();
                    const sl = (layer["source-layer"] || "").toLowerCase();

                    // Skip anything related to borders, labels, or admin boundaries
                    if (id.includes("admin") || id.includes("boundar") || id.includes("label") ||
                        id.includes("country") || id.includes("state") || id.includes("place") ||
                        sl.includes("admin") || sl.includes("boundar")) {
                        continue;
                    }

                    if (id.includes("road") || sl.includes("road")) {
                        map.setLayoutProperty(layer.id, "visibility", "none");
                    }
                }
            } catch (e) {
                console.warn("[map] Road layer hiding failed:", e);
            }
        });

        // -- Map error recovery -----------------------------------------------

        map.on("error", (e) => {
            const err = e?.error || e;
            const status = err?.status || err?.statusCode || "";
            const msg = err?.message || err?.url || (typeof err === "object" ? JSON.stringify(err) : String(err));
            console.warn("[map] Error event:", status ? `HTTP ${status} — ${msg}` : msg);

            if (_fallbackLevel < 2) {
                fallbackStyle(status ? `HTTP ${status}` : msg);
            }
        });

        // WebGL context lost — the GPU dropped the context entirely
        const canvas = map.getCanvas();
        if (canvas) {
            canvas.addEventListener("webglcontextlost", (e) => {
                console.error("[map] WebGL context lost. The map will attempt to restore automatically.");
                e.preventDefault();  // allow Mapbox to attempt restore
            });
        }

        setLoadingProgress(40);
        await new Promise(resolve => map.on("load", resolve));
        setLoadingProgress(60);

        // Force canvas resize — fixes iOS Safari where the container
        // dimensions aren't picked up correctly on first render.
        map.resize();
        // Delayed second resize — some iOS devices need a frame to
        // calculate the correct container dimensions after layout.
        setTimeout(() => { try { map.resize(); } catch (e) { /* ignore */ } }, 250);

        // -- Tile-load timeout ------------------------------------------------
        // If Mapbox fires "load" but tiles never actually render (canvas stays
        // empty), fall back after 8 seconds.  The "idle" event means all tiles
        // for the current viewport have been loaded and rendered.
        let _tilesRendered = false;
        map.once("idle", () => { _tilesRendered = true; });
        setTimeout(() => {
            if (!_tilesRendered && _fallbackLevel < 2) {
                console.warn("[map] Tile-load timeout — tiles did not render within 8 seconds.");
                fallbackStyle("tile-load timeout");
            }
        }, 8000);

        map.setMinZoom(UNLOCKED_MIN_ZOOM);
        map.setMaxZoom(UNLOCKED_MAX_ZOOM);

        // -- Route sentinels --------------------------------------------------

        const finalStop = stops.find(s => Number(s.DR) === FINAL_DR) || stops[stops.length - 1];
        const FINAL_ARRIVAL = Number(finalStop.UnixArrivalArrival);

        const takeoffStop = stops.find(s => Number(s.DR) === TAKEOFF_DR) || stops.find(s => Number(s.DR) >= TAKEOFF_DR);
        const TAKEOFF_ARRIVAL = takeoffStop ? Number(takeoffStop.UnixArrivalArrival) : null;

        // Decide who owns dismissing the loading overlay. During the active
        // delivery window with 3D enabled, the space-to-bunny intro
        // (activate3dJourney -> waitForReady) owns the reveal, so we leave the
        // overlay alone here. In every other case (2D, or pre/post-journey) the
        // generic readiness check below owns it.
        const inDeliveryWindow = (() => {
            const nowCheck = serverNowSec();
            return Number.isFinite(TAKEOFF_ARRIVAL) && nowCheck >= TAKEOFF_ARRIVAL &&
                !(Number.isFinite(FINAL_ARRIVAL) && nowCheck >= FINAL_ARRIVAL);
        })();
        const willRun3dIntro = tracking3dEnabled && inDeliveryWindow;

        // Preload the marker images so baskets/eggs/bunny don't pop in after
        // the map appears. Resolves on load OR error (a missing image must not
        // trap the loading screen).
        function preloadMarkerImages() {
            const urls = ["assets/img/Bunny.png", "assets/img/Basket.png", "assets/img/Egg.png"];
            return Promise.all(urls.map(src => new Promise(resolve => {
                const im = new Image();
                im.onload = im.onerror = () => resolve();
                im.src = src;
            })));
        }

        // Generic reveal: wait until the first tiles have rendered and the
        // marker images are decoded, then take the overlay down. The global
        // failsafe above still guarantees it can never hang.
        function revealTrackerWhenReady() {
            const tilesReady = new Promise(resolve => {
                if (_tilesRendered) return resolve();
                map.once("idle", resolve);
            });
            Promise.all([tilesReady, preloadMarkerImages()]).then(() => {
                readyToReveal = true;
                dismissLoading();
            });
        }

        if (!willRun3dIntro) revealTrackerWhenReady();

        // -- Remaining session state -------------------------------------------

        let isDelivering = false;
        let currentSegDR = null;
        let currentTravelBearingDeg = 0;
        let currentTravelDirection = null;
        let journey3dActivated = false;
        let introAnimPlaying = false;   // suppresses followBunnyIfLocked during space-to-bunny intro
        let userZoom3d = null;          // user's scroll-chosen 3D zoom (null = designed default)
        let lastSegMode = null;
        let lastSegToIndex = null;

        // Viewer-location ETA state
        let viewerLocation = null;
        let viewerClosestStop = null;
        let viewerEtaError = false;

        // City panel state
        let currentCityStop = null;
        let currentCityTimezone = null;

        // -- Camera lock ------------------------------------------------------

        // Zoom to add so the balloon keeps a constant on-screen size regardless
        // of latitude (Mercator renders a fixed-size object ~1/cos(lat) bigger
        // toward the poles). 0 at the equator, negative toward the poles; the
        // latitude is clamped so the correction stays sane in polar regions.
        function latZoomComp() {
            const bll = bunnyMarker ? bunnyMarker.getLngLat() : map.getCenter();
            const latAbs = Math.min(Math.abs(bll.lat), 75);
            return Math.log2(Math.cos(latAbs * Math.PI / 180));
        }

        // The actual cruise zoom: the base (equator) zoom — user-chosen or the
        // designed default — plus the latitude compensation, clamped sane.
        function effectiveCruiseZoom() {
            const base = (userZoom3d !== null) ? userZoom3d : TRACKING_3D_LOCKED_ZOOM;
            return Math.max(9, Math.min(12, base + latZoomComp()));
        }

        function getLockedZoom() {
            const isPre = currentSegDR !== null && Number.isFinite(currentSegDR) &&
                (currentSegDR < TAKEOFF_DR || currentSegDR === FINAL_DR);

            if (tracking3dEnabled && journey3dActivated) {
                if (isPre) return TRACKING_3D_LOCKED_ZOOM_PRE;
                // Honor the user's scroll-chosen zoom (as a base) and keep the
                // balloon the same apparent size at every latitude.
                return effectiveCruiseZoom();
            }
            return isPre ? LOCKED_ZOOM_PRE : LOCKED_ZOOM;
        }

        function getLockedPitch() {
            return (tracking3dEnabled && journey3dActivated) ? TRACKING_3D_PITCH : 0;
        }

        function getLockedBearing() {
            return (tracking3dEnabled && journey3dActivated) ? currentTravelBearingDeg + TRACKING_3D_BEARING_OFFSET : 0;
        }

        // Offset a lng/lat by a distance (meters) along a compass bearing.
        function offsetLngLat(lng, lat, bearingDeg, distMeters) {
            if (!distMeters) return { lng, lat };
            const R = 6371000;
            const br = bearingDeg * Math.PI / 180;
            const dr = distMeters / R;
            const latR = lat * Math.PI / 180;
            const lngR = lng * Math.PI / 180;
            const lat2 = Math.asin(Math.sin(latR) * Math.cos(dr) + Math.cos(latR) * Math.sin(dr) * Math.cos(br));
            const lng2 = lngR + Math.atan2(
                Math.sin(br) * Math.sin(dr) * Math.cos(latR),
                Math.cos(dr) - Math.sin(latR) * Math.sin(lat2));
            return { lng: lng2 * 180 / Math.PI, lat: lat2 * 180 / Math.PI };
        }

        // The point the locked camera should look at. In 3D we frame the BUNNY
        // himself (who floats at altitude), not the ground beneath him: pushing
        // the look-at point ahead of the bunny by height*tan(pitch) puts him on
        // the center ray, so he stays framed however high he flies and zoom only
        // changes his on-screen size. The height is his feet altitude PLUS half
        // his model height, so the camera frames his middle — otherwise his tall
        // body sits above the center ray with his head clipped off the top. In
        // 2D / pre / post it's just the bunny's ground position.
        // Framing center for an ARBITRARY camera bearing/pitch — so the bunny
        // stays centered whatever angle the camera is at, including while the
        // user is orbiting or has orbited away from the designed angles.
        function framingCenterAt(bearingDeg, pitchDeg) {
            const bll = bunnyMarker ? bunnyMarker.getLngLat() : map.getCenter();
            if (!(tracking3dEnabled && journey3dActivated)) return { lng: bll.lng, lat: bll.lat };
            const alt = (bunny3d && bunny3d.getAltitude) ? bunny3d.getAltitude() : TRACKING_3D_FLIGHT_ALTITUDE;
            // Lock onto the bunny in the basket (low in the model), not the
            // balloon: target a small fraction of the model's height above his
            // feet. The centered world-height = feet altitude + that offset.
            const modelH = (bunny3d && bunny3d.getModelHeight) ? bunny3d.getModelHeight() : 0;
            const frameOff = modelH * TRACKING_3D_FRAME_HEIGHT_FRAC;
            const aheadM = (alt + frameOff) * Math.tan(pitchDeg * Math.PI / 180);
            return offsetLngLat(bll.lng, bll.lat, bearingDeg, aheadM);
        }

        // Framing center at the DESIGNED locked angles — used as the target of
        // the camera transitions (relock, new segment, intro) that ease toward
        // those angles.
        function framingCenter() {
            return framingCenterAt(getLockedBearing(), getLockedPitch());
        }

        let relockAnimating = false;

        function followBunnyIfLocked() {
            if (!isLocked || !bunnyMarker || introAnimPlaying || relockAnimating) return;

            if (tracking3dEnabled && journey3dActivated) {
                // 3D: keep the camera framed on the bunny at whatever angle the
                // camera is currently at (so he stays centered after the user
                // orbits), letting the user's bearing/pitch stand. Zoom tracks
                // the latitude compensation so his on-screen size stays constant
                // as he travels between latitudes.
                const target = framingCenterAt(map.getBearing(), map.getPitch());
                const targetZoom = getLockedZoom();
                const c = map.getCenter();
                const centerUnchanged =
                    Math.abs(c.lng - target.lng) < 1e-9 &&
                    Math.abs(c.lat - target.lat) < 1e-9;
                const zoomUnchanged = Math.abs(map.getZoom() - targetZoom) < 0.02;
                if (!centerUnchanged || !zoomUnchanged) {
                    map.jumpTo({ center: target, zoom: targetZoom });
                }
                return;
            }

            // Skip the camera call entirely when nothing changed — a jumpTo/
            // setCenter with identical values still forces Mapbox to re-render
            // the whole frame, which used to keep the GPU busy at stops.
            const target = framingCenter();
            const c = map.getCenter();
            const centerUnchanged =
                Math.abs(c.lng - target.lng) < 1e-9 &&
                Math.abs(c.lat - target.lat) < 1e-9;

            {
                if (centerUnchanged &&
                    map.getZoom() === getLockedZoom() &&
                    map.getPitch() === getLockedPitch() &&
                    map.getBearing() === getLockedBearing()) return;
                map.jumpTo({
                    center: target,
                    zoom: getLockedZoom(),
                    pitch: getLockedPitch(),
                    bearing: getLockedBearing()
                });
            }
        }

        function setLocked(nextLocked) {
            isLocked = !!nextLocked;

            const btn = $("lockBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(isLocked));
                btn.textContent = isLocked ? "\uD83D\uDD13 Unlock Camera" : "\uD83D\uDD12 Lock to Bunny";
                btn.title = isLocked ? "Unlock camera" : "Lock camera to Bunny";
            }

            if (isLocked) {
                // Locked = the designed framing, held automatically. All manual
                // camera control is off; the camera follows the bunny at the
                // designed zoom/pitch/bearing and reverts to it on every lock.
                map.dragPan.disable();
                map.boxZoom.disable();
                map.doubleClickZoom.disable();
                map.dragRotate.disable();
                map.scrollZoom.disable();
                map.keyboard.disable();
                map.touchZoomRotate.disable();
                if (map.touchPitch) map.touchPitch.disable();

                if (bunnyMarker && !introAnimPlaying) {
                    relockAnimating = true;
                    map.easeTo({
                        center: framingCenter(),
                        zoom: getLockedZoom(),
                        pitch: getLockedPitch(),
                        bearing: getLockedBearing(),
                        duration: 800
                    });
                    setTimeout(() => { relockAnimating = false; }, 850);
                }
            } else {
                // Unlocked = full manual control: pan, zoom, rotate, and tilt/pitch.
                map.dragPan.enable();
                map.scrollZoom.enable();
                map.boxZoom.enable();
                map.dragRotate.enable();
                map.keyboard.enable();
                map.doubleClickZoom.enable();
                map.touchZoomRotate.enable();
                if (map.touchPitch) map.touchPitch.enable();
                map.setMinZoom(UNLOCKED_MIN_ZOOM);
                map.setMaxZoom(UNLOCKED_MAX_ZOOM);
            }
        }

        // -- Markers ----------------------------------------------------------

        let bunnyMarker = null;

        function createBunnyMarker(stop) {
            const container = document.createElement("div");
            container.style.cssText = "position:relative;width:46px;height:46px;pointer-events:none;";

            const shadow = document.createElement("div");
            shadow.style.cssText = [
                "position:absolute", "left:50%", "bottom:4px",
                "transform:translateX(-50%)", "width:42px", "height:25px",
                "border-radius:50%",
                "background:radial-gradient(circle,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 70%)",
                "filter:blur(1px)", "opacity:.8"
            ].join(";");

            const img = document.createElement("img");
            img.src = "assets/img/Bunny.png";
            img.alt = "Easter Bunny";
            img.style.cssText = [
                "position:absolute", "left:50%", "bottom:0",
                "transform:translateX(-50%) translateY(4px)",
                "width:43px", "height:43px", "pointer-events:none"
            ].join(";");

            container.appendChild(shadow);
            container.appendChild(img);

            bunnyMarker = new mapboxgl.Marker({ element: container, anchor: "bottom" })
                .setLngLat([stop.Longitude, stop.Latitude])
                .addTo(map);
        }

        // Position/animation/heading all delegate to the decoupled 3D renderer
        // (bunny3d, created further down — these only run from the tick loop,
        // long after init completes).

        function updateBunnyPosition(lon, lat) {
            if (bunnyMarker) bunnyMarker.setLngLat([lon, lat]);
            if (bunny3d) bunny3d.setPosition(lon, lat);
        }

        function set3dBunnyTraveling(traveling) {
            if (bunny3d) bunny3d.setTraveling(traveling);
        }

        function set3dBunnyHeading(bearingDegrees) {
            if (bunny3d) bunny3d.setHeading(bearingDegrees);
        }

        // -- Baskets (GPU symbol layer) ---------------------------------------
        // Baskets used to be DOM markers (mapboxgl.Marker). Two problems:
        //   1. DOM markers have no depth, so baskets on the far side of the
        //      globe stayed visible — a row of PNGs floating above the horizon.
        //   2. Mapbox re-projects and re-positions EVERY DOM marker on every
        //      frame. By the end of the route that's ~1000 nodes per frame.
        // A symbol layer fixes both: the GPU draws them in one batch and the
        // globe correctly occludes anything past the horizon.

        const BASKET_SOURCE = "baskets";
        const BASKET_LAYER = "basket-symbols";
        const BASKET_ICON = "eb-basket";

        const basketKeys = new Set();
        const basketFeatures = [];
        let basketIconData = null;   // downscaled ImageData for the icon atlas
        let basketsDirty = false;

        // Basket.png is ~1 MB at full resolution but renders at 24 px. Decode
        // it once into a small ImageData so the icon atlas stays tiny.
        (function loadBasketIcon() {
            const img = new Image();
            img.onload = () => {
                const S = 56;   // 56 px @ pixelRatio 2 == 28 CSS px (keeps the slightly larger icon crisp)
                const c = document.createElement("canvas");
                c.width = S; c.height = S;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0, S, S);
                basketIconData = ctx.getImageData(0, 0, S, S);
                ensureBasketLayer();
            };
            img.onerror = () => console.warn("[baskets] Failed to load Basket.png");
            img.src = "assets/img/Basket.png";
        })();

        function ensureBasketLayer() {
            if (!basketIconData || !map.isStyleLoaded()) return;
            try {
                if (!map.hasImage(BASKET_ICON)) {
                    map.addImage(BASKET_ICON, basketIconData, { pixelRatio: 2 });
                }
                if (!map.getSource(BASKET_SOURCE)) {
                    map.addSource(BASKET_SOURCE, {
                        type: "geojson",
                        data: { type: "FeatureCollection", features: basketFeatures }
                    });
                }
                if (!map.getLayer(BASKET_LAYER)) {
                    map.addLayer({
                        id: BASKET_LAYER,
                        type: "symbol",
                        source: BASKET_SOURCE,
                        layout: {
                            "icon-image": BASKET_ICON,
                            // Shrink when zoomed out so the trail of visited
                            // cities reads as dots rather than a wall of PNGs.
                            "icon-size": [
                                "interpolate", ["linear"], ["zoom"],
                                3, 0.52,
                                7, 0.8,
                                11, 1.15
                            ],
                            // Skip collision detection entirely — cheaper, and
                            // matches the old always-visible marker behaviour.
                            "icon-allow-overlap": true,
                            "icon-ignore-placement": true,
                            "icon-anchor": "bottom",
                            "icon-pitch-alignment": "viewport",
                            "icon-rotation-alignment": "viewport"
                        }
                    });
                }
                flushBaskets(true);
            } catch (e) {
                console.warn("[baskets] Layer setup failed:", e);
            }
        }

        function addBasketForStop(stop) {
            const dr = Number(stop.DR);
            if (Number.isFinite(dr) && dr < BASKET_START_DR) return;

            const key = String(stop.DR ?? stop.UnixArrival);
            if (basketKeys.has(key)) return;
            basketKeys.add(key);

            const cityName = cityLabel(stop);
            basketFeatures.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [stop.Longitude, stop.Latitude] },
                properties: {
                    desc: stop.WikipediaUrl
                        ? `<span style="color:#333;">More info:</span> <a href="${stop.WikipediaUrl}" target="_blank" rel="noopener noreferrer">${cityName}</a>`
                        : cityName
                }
            });
            basketsDirty = true;
        }

        // setData is a full source reparse — only call it when something
        // actually changed, and at most once per tick.
        function flushBaskets(force) {
            if (!basketsDirty && !force) return;
            const src = map.getSource(BASKET_SOURCE);
            if (!src) return;
            src.setData({ type: "FeatureCollection", features: basketFeatures });
            basketsDirty = false;
        }

        map.on("click", BASKET_LAYER, (e) => {
            const f = e.features && e.features[0];
            if (!f) return;
            new mapboxgl.Popup({ offset: 24 })
                .setLngLat(f.geometry.coordinates.slice())
                .setHTML(f.properties.desc)
                .addTo(map);
        });
        map.on("mouseenter", BASKET_LAYER, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", BASKET_LAYER, () => { map.getCanvas().style.cursor = ""; });

        // style.load wipes images, sources and layers — rebuild them.
        map.on("style.load", ensureBasketLayer);
        ensureBasketLayer();

        createBunnyMarker(firstStop);
        setLocked(true);

        // -- Egg delivery FX --------------------------------------------------

        const eggImg = document.createElement("img");
        eggImg.src = "assets/img/Egg.png";
        eggImg.alt = "";
        eggImg.style.cssText = [
            "position:absolute", "width:22px", "height:26px",
            "pointer-events:none", "opacity:0", "z-index:2",
            "transform:translate(-50%,-100%)"
        ].join(";");
        document.body.appendChild(eggImg);

        // The egg animation runs only while the bunny is actively delivering.
        // The tick loop calls ensureEggAnimation() to (re)start it when needed.
        let _eggAnimRunning = false;
        let _eggHidden = true;

        function animateEgg(timestamp) {
            if (!bunnyMarker || !isDelivering) {
                if (!_eggHidden) {
                    eggImg.style.opacity = "0";
                    _eggHidden = true;
                }
                _eggAnimRunning = false;
                return;
            }
            _eggHidden = false;

            const phase = (timestamp / 1000) % 1;
            const fadeIn = 0.15;
            const fadeOut = 0.20;

            let a = 1;
            if (phase < fadeIn) a = phase / fadeIn;
            else if (phase > 1 - fadeOut) a = (1 - phase) / fadeOut;

            const pt = map.project(bunnyMarker.getLngLat());
            const risePx = phase * 28;

            eggImg.style.left = `${pt.x}px`;
            eggImg.style.top = `${pt.y - 44 - risePx}px`;
            eggImg.style.opacity = `${Math.max(0, Math.min(1, a))}`;

            requestAnimationFrame(animateEgg);
        }

        function ensureEggAnimation() {
            if (_eggAnimRunning || !isDelivering) return;
            _eggAnimRunning = true;
            requestAnimationFrame(animateEgg);
        }

        // -- HUD DOM refs -----------------------------------------------------

        const statStatusRow = $("statStatus")?.closest(".hud-row") ?? null;
        const statEtaRow = $("statEta")?.closest(".hud-row") ?? null;
        const statDurationRow = $("statDuration")?.closest(".hud-row") ?? null;
        const statStopRemainingRow = $("statStopRemaining")?.closest(".hud-row") ?? null;

        const statEtaLabelEl = (() => {
            const row = $("statEta")?.closest(".hud-row");
            return row ? row.querySelector("span:first-child") : null;
        })();

        // -- HUD update functions ---------------------------------------------

        function setEtaLabel(isBefore77) {
            if (statEtaLabelEl) statEtaLabelEl.textContent = isBefore77 ? "Countdown to takeoff:" : "Arriving in:";
        }

        function setViewerEtaVisibility(show) {
            if (statDurationRow) statDurationRow.style.display = (show && showStatArrivalEstimate) ? "" : "none";
        }

        function setStopRemainingVisibility(show) {
            if (statStopRemainingRow) statStopRemainingRow.style.display = show ? "" : "none";
        }

        function updateHUD({ status, lastText, etaSeconds, etaText, stopRemainingSeconds, speedKmh, speedMph, eggs, carrots }) {
            $("statStatus").textContent = status ?? "\u2014";
            $("statLast").textContent = lastText ?? "\u2014";

            $("statEta").textContent = typeof etaText === "string"
                ? etaText
                : formatDurationWords(etaSeconds);

            $("statStopRemaining").textContent = formatDurationWords(stopRemainingSeconds);

            if (Number.isFinite(speedKmh) && Number.isFinite(speedMph)) {
                const km = Math.round(speedKmh);
                const mph = Math.round(speedMph);

                $("statSpeed").textContent = speedUnitMode === "kmh"
                    ? `${Math.abs(km) >= 1000 ? formatInt(km) : km} km/h`
                    : `${Math.abs(mph) >= 1000 ? formatInt(mph) : mph} mph`;
            } else {
                $("statSpeed").textContent = "\u2014";
            }

            $("statEggs").textContent = formatInt(eggs);
            $("statCarrots").textContent = formatInt(carrots);
        }

        function updateViewerLocationEta(now) {
            if (!statDurationEl) return;
            if (statDurationRow?.style.display === "none") return;

            if (streamerModeEnabled) {
                statDurationEl.textContent = "HIDDEN | S.M. enabled";
                return;
            }
            if (viewerEtaError) {
                if (!statDurationEl.textContent || statDurationEl.textContent === "Loading..." || statDurationEl.textContent === "HIDDEN | S.M. enabled") {
                    statDurationEl.textContent = "Unknown";
                }
                return;
            }
            if (!viewerClosestStop) return;

            const arrival = Number(viewerClosestStop.UnixArrivalArrival);
            statDurationEl.textContent = Number.isFinite(arrival)
                ? formatViewerEtaText(arrival - now)
                : "Unknown";
        }

        // -- City panel -------------------------------------------------------

        const cityPanel = $("cityPanel");
        const cityTitleEl = $("cityTitle");
        const cityLocalTimeEl = $("cityLocalTime");
        const cityWeatherEl = $("cityWeather");
        const cityPopulationEl = $("cityPopulation");
        const cityElevationEl = $("cityElevation");
        const cityDirectionEl = $("cityDirection");

        // City panel collapse state resets on every load - only the user's
        // show/hide preference (set via the external button) is persisted.
        let cityPanelCollapsed = false;

        function applyCityPanelCollapsed() {
            if (!cityPanel) return;
            cityPanel.classList.toggle("is-collapsed", cityPanelCollapsed);

            cityPanel.querySelectorAll(".city-panel-row").forEach(r => {
                r.style.display = cityPanelCollapsed ? "none" : "";
            });

            const hr = cityPanel.querySelector("hr");
            const footer = cityPanel.querySelector("footer");
            if (hr) hr.style.display = cityPanelCollapsed ? "none" : "";
            if (footer) footer.style.display = cityPanelCollapsed ? "none" : "";

            const btn = cityPanel.querySelector(".city-collapse-btn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(cityPanelCollapsed));
                btn.textContent = cityPanelCollapsed ? "\u25be" : "\u25b4";
                btn.title = cityPanelCollapsed ? "Expand" : "Minimize";
                btn.setAttribute("aria-label", cityPanelCollapsed ? "Expand city panel" : "Minimize city panel");
            }
        }

        function initCityPanelCollapseUI() {
            if (!cityPanel) return;
            applyCityPanelCollapsed();
        }

        function updateCityPanel(now, seg) {
            if (!cityPanel) return;

            const toggleBtn = $("cityInfoToggleBtn");

            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                cityPanel.hidden = true;
                if (toggleBtn) toggleBtn.hidden = true;
                currentCityStop = null;
                applyCityPanelCollapsed();
                return;
            }

            const s = seg?.mode === "stop" ? stops[seg.i] :
                seg?.mode === "travel" ? stops[seg.to] :
                    stops[0];

            if (!s) { cityPanel.hidden = true; currentCityStop = null; return; }

            const dr = Number(s.DR);
            if (!Number.isFinite(dr) || dr < CITY_PANEL_MIN_DR) {
                cityPanel.hidden = true;
                if (toggleBtn) toggleBtn.hidden = true;
                currentCityStop = null;
                return;
            }

            // Journey has begun - show the toggle button
            if (toggleBtn) toggleBtn.hidden = false;

            // User has manually hidden the panel - keep button visible but panel hidden
            if (!cityInfoUserVisible) return;

            cityPanel.hidden = false;
            currentCityStop = s;

            if (cityTitleEl) cityTitleEl.textContent = `Information about: ${s.City || "Unknown city"}`;

            if (cityPopulationEl) {
                const pop = Number(s.PopulationNum);
                cityPopulationEl.textContent = (Number.isFinite(pop) && pop > 0)
                    ? (s.PopulationYear ? `${formatInt(pop)} (as of ${s.PopulationYear})` : formatInt(pop))
                    : "Unknown";
            }

            if (cityElevationEl) {
                const elev = Number(s.ElevationMeter);
                cityElevationEl.textContent = Number.isFinite(elev) ? `${formatInt(elev)} meters` : "Unknown";
            }

            if (cityDirectionEl) {
                cityDirectionEl.textContent = currentTravelDirection
                    ? `${currentTravelDirection.arrow} | ${currentTravelDirection.text}`
                    : "N/A";
            }

            if (cityLocalTimeEl) {
                const tz = s.Timezone || null;
                try {
                    cityLocalTimeEl.textContent = new Date().toLocaleTimeString(undefined, {
                        timeZone: tz || undefined, hour: "numeric", minute: "2-digit"
                    });
                } catch {
                    cityLocalTimeEl.textContent = new Date().toLocaleTimeString(undefined, {
                        hour: "numeric", minute: "2-digit"
                    });
                }
            }

            if (cityWeatherEl) {
                cityWeatherEl.innerHTML = s.WikipediaUrl
                    ? `<a href="${s.WikipediaUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;">Wikipedia article \u2197</a>`
                    : "No article available";
            }
        }

        initCityPanelCollapseUI();

        // -- Viewer location lookup (non-blocking) -----------------------------

        fetchViewerLocationFromIpInfo().then(loc => {
            if (!loc) {
                viewerEtaError = true;
                if (statDurationEl) statDurationEl.textContent = "Unknown";
                return;
            }
            viewerLocation = loc;
            viewerClosestStop = findClosestStopByLocation(stops, loc.lat, loc.lon);
        }).catch(err => {
            console.warn("Viewer location lookup failed:", err);
            viewerEtaError = true;
            if (statDurationEl) statDurationEl.textContent = "Unknown";
        });

        // -- 3D Tracking --------------------------------------------------------
        // The heavy lifting lives in bunny3d.js: the model renders on its own
        // transparent canvas + WebGL context layered over the map, so animating
        // him no longer forces full-map repaints. The map only re-renders when
        // the camera actually moves; the bunny redraws independently at a
        // capped rate (and synchronously with the map whenever the camera is
        // in motion, via the matrix-probe layer — see bunny3d.js).

        // Reference to the 2D marker's container so the LOD swap can hide it
        const bunny2dContainer = bunnyMarker?.getElement() ?? null;

        const bunny3d = (typeof createBunny3D === "function")
            ? createBunny3D(map, {
                modelUrl: "assets/3d/bunny2.gltf",
                scale: TRACKING_3D_MODEL_SCALE,
                zoomThreshold: TRACKING_3D_ZOOM_THRESHOLD,
                flightAltitude: TRACKING_3D_FLIGHT_ALTITUDE,
                headingOffsetDeg: TRACKING_3D_MODEL_HEADING_OFFSET,
                onVisibilityChange(show3d) {
                    // Below the zoom threshold the model is too small to read —
                    // swap back to the classic 2D sprite.
                    if (bunny2dContainer) bunny2dContainer.style.display = show3d ? "none" : "";
                }
            })
            : null;

        // -- 3D chase-cam framing ---------------------------------------------
        // Reserve the top of the viewport so the (camera-centered) bunny sits
        // in the lower third of the screen with the route ahead filling the
        // frame — instead of dead-center under the HUD. Padding is a one-time
        // camera parameter: it costs nothing per frame.
        function apply3dPadding() {
            const h = map.getContainer()?.clientHeight || 0;
            map.setPadding({ top: Math.round(h * TRACKING_3D_TOP_PADDING_FRAC), bottom: 0, left: 0, right: 0 });
        }

        function clear3dPadding() {
            map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
        }

        map.on("resize", () => {
            if (journey3dActivated) apply3dPadding();
        });

        // Transition into 3D mode with a space-to-bunny camera sweep.
        // Waits for GLB model + map tiles to be ready before playing.
        function activate3dJourney() {
            if (journey3dActivated || !tracking3dEnabled) return;
            journey3dActivated = true;
            introAnimPlaying = true;
            mapDimensionMode = "3d";
            apply3dPadding();

            setLoadingProgress(70);

            const bunnyPos = bunnyMarker ? bunnyMarker.getLngLat() : { lng: firstStop.Longitude, lat: firstStop.Latitude };

            // Switch to globe and start from space
            map.jumpTo({ center: bunnyPos, zoom: 1.5, pitch: 0, bearing: 0 });
            applyMapDimensionMode();
            if (bunny3d) bunny3d.setEnabled(true);

            // Wait for GLB to finish loading + map to be idle (tiles rendered)
            function waitForReady() {
                return new Promise(resolve => {
                    let glbReady = !bunny3d || bunny3d.isLoaded();
                    let tilesReady = false;
                    let settled = false;

                    const glbInterval = setInterval(() => {
                        if (!glbReady && (!bunny3d || bunny3d.isLoaded())) {
                            glbReady = true;
                            setLoadingProgress(85);
                            check();
                        }
                    }, 100);

                    function check() {
                        if (!settled && glbReady && tilesReady) {
                            settled = true;
                            clearInterval(glbInterval);
                            setLoadingProgress(95);
                            resolve();
                        }
                    }

                    if (glbReady) setLoadingProgress(85);

                    map.once("idle", () => {
                        tilesReady = true;
                        setLoadingProgress(90);
                        check();
                    });

                    // Safety timeout — don't wait forever
                    setTimeout(() => {
                        glbReady = true;
                        tilesReady = true;
                        check();
                    }, 10000);
                });
            }

            waitForReady().then(() => {
                readyToReveal = true;   // 3D intro owns the reveal — release the gate
                dismissLoading();

                // Sweep down to frame the balloon
                setTimeout(() => {
                    map.easeTo({
                        center: framingCenter(),
                        zoom: getLockedZoom(),
                        pitch: TRACKING_3D_PITCH,
                        bearing: getLockedBearing(),
                        duration: 4000,
                        easing: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
                    });

                    setTimeout(() => {
                        introAnimPlaying = false;
                        // Re-apply lock to enable 3D orbit controls
                        if (isLocked) setLocked(true);
                        startLagMonitorIfNeeded();
                    }, 4100);
                }, 400);
            });
        }

        // Revert from 3D back to 2D (flat map, 2D sprite, 2D camera).
        // Used for pre-journey and journey-complete phases.
        function deactivate3dJourney() {
            if (!journey3dActivated) return;
            journey3dActivated = false;
            userZoom3d = null;   // forget any scroll-zoom; next 3D run starts at the default
            mapDimensionMode = "2d";
            clear3dPadding();
            applyMapDimensionMode();
            if (bunny3d) bunny3d.setEnabled(false);
            dismissLoading();
        }

        function updateTracking3dButton() {
            const btn = $("tracking3dBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(tracking3dEnabled));
            btn.textContent = tracking3dEnabled ? "3D Tracking: On" : "3D Tracking: Off";
        }

        const tracking3dBtn = $("tracking3dBtn");
        if (tracking3dBtn) {
            tracking3dBtn.addEventListener("click", () => {
                tracking3dEnabled = !tracking3dEnabled;
                saveSettings({ tracking3dEnabled });
                updateTracking3dButton();

                if (!tracking3dEnabled) {
                    // Turning off — always revert to 2D (deactivate handles the
                    // active-journey case; the else covers pre/post-journey
                    // where the globe projection may still be applied)
                    if (journey3dActivated) {
                        deactivate3dJourney();
                    } else {
                        mapDimensionMode = "2d";
                        applyMapDimensionMode();
                        if (bunny3d) bunny3d.setEnabled(false);
                    }
                    dismissLoading();
                } else if (journey3dActivated || (currentSegDR !== null && currentSegDR >= TAKEOFF_DR)) {
                    // Turning on mid-journey — activate 3D immediately
                    activate3dJourney();
                }
                // else: turning on during pre-journey — stay 2D, will activate at takeoff
            });
        }
        updateTracking3dButton();

        // -- Smooth motion loop -------------------------------------------------
        // tick() (10 Hz) decides *what* the bunny is doing; this rAF loop makes
        // the motion smooth by recomputing his exact position from the route
        // timestamps every frame while traveling, instead of stepping every
        // 100 ms. It also drives the locked camera. At stops the loop shuts
        // itself off entirely — tick() owns the (static) position there.

        let followFrameMs = 33;    // camera/marker update cadence (~30 fps)
        let activeLeg = null;      // { from, to } while traveling, else null
        let motionRafId = null;
        let _lastMotionMs = 0;

        // True while the bunny is touching down / lifting off — his altitude is
        // still easing, so the camera must keep re-framing smoothly even though
        // he's at a fixed lng/lat (no leg to animate).
        function altitudeAnimating() {
            return !!(bunny3d && bunny3d.isAltitudeAnimating && bunny3d.isAltitudeAnimating());
        }

        function motionFrame(ts) {
            motionRafId = null;
            // Keep the smooth loop alive while traveling OR while the altitude is
            // still easing (descent at a stop / ascent at departure).
            if (!activeLeg && !altitudeAnimating()) return;
            motionRafId = requestAnimationFrame(motionFrame);
            if (ts - _lastMotionMs < followFrameMs) return;
            _lastMotionMs = ts;

            if (activeLeg) {
                const now = serverNowSec();
                const departT = activeLeg.from.UnixArrivalDeparture;
                const arriveT = activeLeg.to.UnixArrivalArrival;
                const t = clamp01((now - departT) / Math.max(1, arriveT - departT));
                const pos = interpolateLatLon(activeLeg.from, activeLeg.to, t);
                updateBunnyPosition(pos.lon, pos.lat);
            }
            // At a stop the position is fixed; this only re-frames the camera as
            // the altitude eases, keeping the touch-down zoom-out smooth.
            followBunnyIfLocked();
        }

        function ensureMotionLoop() {
            if (motionRafId === null) motionRafId = requestAnimationFrame(motionFrame);
        }

        function setActiveLeg(from, to) {
            if (!from || !to) {
                activeLeg = null;
                // Don't stop the loop outright — it may still need to animate the
                // touch-down re-framing; motionFrame exits itself once settled.
                if (altitudeAnimating()) ensureMotionLoop();
                return;
            }
            if (activeLeg && activeLeg.from === from && activeLeg.to === to) return;
            activeLeg = { from, to };
            ensureMotionLoop();
        }

        // -- 3D lag safeguard ---------------------------------------------------
        // With the decoupled renderer nothing forces map frames any more, but a
        // genuinely weak device can still struggle while the camera is moving.
        // Watch main-thread frame pacing while 3D is active: silently halve the
        // frame caps once, then offer a one-click switch back to 2D.

        const LAG_FPS_THRESHOLD = 20;       // rAF cadence considered "struggling"
        const LAG_SUSTAIN_MS = 5000;        // must stay below threshold this long
        const LAG_GRACE_MS = 3000;          // ignore the first seconds after activation
        const LAG_SAMPLE_WINDOW = 60;       // rolling frame-timestamp window

        let lagBannerShown = false;         // only prompt once per session
        let lagBannerDismissed = false;     // user said "no thanks" — don't ask again
        let lagSampleTimes = [];
        let lagBelowSince = 0;
        let lagLoopActive = false;
        let lagActiveSince = 0;
        let lagDegraded = false;            // one silent degrade step before the banner

        function is3dActive() {
            return tracking3dEnabled && journey3dActivated && !introAnimPlaying;
        }

        function showLagBanner() {
            if (lagBannerShown || lagBannerDismissed) return;
            lagBannerShown = true;

            const wrap = document.createElement("div");
            wrap.id = "lagWarningBanner";
            wrap.style.cssText = [
                "position:fixed", "left:50%", "bottom:16px",
                "transform:translateX(-50%)",
                "background:rgba(20,20,28,0.92)", "color:#fff",
                "padding:10px 14px", "border-radius:10px",
                "font:500 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif",
                "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
                "display:flex", "align-items:center", "gap:10px",
                "z-index:9999", "max-width:calc(100vw - 24px)"
            ].join(";");

            const msg = document.createElement("span");
            msg.textContent = "3D mode is running slowly. Switch to 2D for smoother tracking?";

            const switchBtn = document.createElement("button");
            switchBtn.type = "button";
            switchBtn.textContent = "Switch to 2D";
            switchBtn.style.cssText = [
                "background:#ffd23f", "color:#222", "border:0",
                "padding:6px 12px", "border-radius:6px",
                "font:600 12px/1 system-ui,sans-serif", "cursor:pointer"
            ].join(";");

            const dismissBtn = document.createElement("button");
            dismissBtn.type = "button";
            dismissBtn.setAttribute("aria-label", "Dismiss");
            dismissBtn.textContent = "Dismiss";
            dismissBtn.style.cssText = [
                "background:transparent", "color:#bbb", "border:1px solid #555",
                "padding:6px 10px", "border-radius:6px",
                "font:500 12px/1 system-ui,sans-serif", "cursor:pointer"
            ].join(";");

            function close() {
                if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
            }

            switchBtn.addEventListener("click", () => {
                close();
                if (!tracking3dEnabled) return;
                tracking3dEnabled = false;
                saveSettings({ tracking3dEnabled });
                updateTracking3dButton();
                deactivate3dJourney();
            });

            dismissBtn.addEventListener("click", () => {
                lagBannerDismissed = true;
                close();
            });

            wrap.appendChild(msg);
            wrap.appendChild(switchBtn);
            wrap.appendChild(dismissBtn);
            document.body.appendChild(wrap);
        }

        function lagSampleTick(now) {
            if (!is3dActive() || lagBannerShown || lagBannerDismissed) {
                lagLoopActive = false;
                lagSampleTimes.length = 0;
                lagBelowSince = 0;
                return;
            }

            lagSampleTimes.push(now);
            if (lagSampleTimes.length > LAG_SAMPLE_WINDOW) lagSampleTimes.shift();

            // Need enough samples, and enough time since activation, before judging.
            if (lagSampleTimes.length >= 30 && now - lagActiveSince > LAG_GRACE_MS) {
                const span = now - lagSampleTimes[0];
                const fps = span > 0 ? (lagSampleTimes.length - 1) * 1000 / span : 60;
                if (fps < LAG_FPS_THRESHOLD) {
                    if (lagBelowSince === 0) lagBelowSince = now;
                    else if (now - lagBelowSince >= LAG_SUSTAIN_MS) {
                        if (!lagDegraded) {
                            // Silent first step: halve the bunny redraw rate and
                            // the camera-follow cadence, then re-evaluate.
                            lagDegraded = true;
                            if (bunny3d) bunny3d.setTargetFps(15);
                            followFrameMs = 66; // ~15 fps camera follow
                            lagSampleTimes.length = 0;
                            lagBelowSince = 0;
                            lagActiveSince = now; // restart grace period
                            console.info("[3D] Degraded to 15 fps due to sustained low frame rate.");
                        } else {
                            // Still rough — surface the banner so the user can
                            // switch to 2D.
                            showLagBanner();
                            return;
                        }
                    }
                } else {
                    lagBelowSince = 0;
                }
            }

            requestAnimationFrame(lagSampleTick);
        }

        function startLagMonitorIfNeeded() {
            if (lagLoopActive || lagBannerShown || lagBannerDismissed) return;
            if (!is3dActive()) return;
            lagLoopActive = true;
            lagActiveSince = performance.now();
            lagSampleTimes.length = 0;
            lagBelowSince = 0;
            requestAnimationFrame(lagSampleTick);
        }

        // -- Map style button -------------------------------------------------

        const mapStyleBtn = $("mapStyleBtn");

        function updateMapStyleButton() {
            if (!mapStyleBtn) return;
            const isSatellite = currentStyle === "satellite";
            mapStyleBtn.setAttribute("aria-pressed", String(isSatellite));
            mapStyleBtn.textContent = isSatellite ? "Map style: Satellite" : "Map style: Standard";
        }

        if (mapStyleBtn) {
            updateMapStyleButton();
            mapStyleBtn.addEventListener("click", () => {
                const center = map.getCenter();
                const zoom = map.getZoom();
                const bearing = map.getBearing();
                const pitch = map.getPitch();

                currentStyle = currentStyle === "standard" ? "satellite" : "standard";
                _fallbackLevel = 0; // reset so fallback chain can re-trigger if needed
                saveSettings({ mapStyle: currentStyle });
                updateMapStyleButton();

                map.setStyle(currentStyle === "satellite" ? SATELLITE_STYLE : STANDARD_STYLE);
                map.once("style.load", () => map.jumpTo({ center, zoom, bearing, pitch }));
            });
        }

        // -- Speed unit button ------------------------------------------------

        function updateSpeedUnitButton() {
            const btn = $("travelSpeedTypeBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(speedUnitMode === "mph"));
            btn.textContent = speedUnitMode === "mph"
                ? "Distance converted in: MPH"
                : "Distance converted in: KM/H";
        }

        const travelSpeedTypeBtn = $("travelSpeedTypeBtn");
        if (travelSpeedTypeBtn) {
            travelSpeedTypeBtn.addEventListener("click", () => {
                speedUnitMode = speedUnitMode === "mph" ? "kmh" : "mph";
                saveSettings({ speedUnitMode });
                updateSpeedUnitButton();
            });
        }
        updateSpeedUnitButton();

        // -- Streamer mode button ---------------------------------------------

        function updateStreamerModeButton() {
            const btn = $("streamerModeBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(streamerModeEnabled));
            btn.textContent = streamerModeEnabled ? "Streamer Mode: Enabled" : "Streamer Mode: Disabled";
        }

        const streamerModeBtn = $("streamerModeBtn");
        if (streamerModeBtn) {
            streamerModeBtn.addEventListener("click", () => {
                streamerModeEnabled = !streamerModeEnabled;
                saveSettings({ streamerModeEnabled });
                updateStreamerModeButton();
                updateViewerLocationEta(serverNowSec());
            });
        }
        updateStreamerModeButton();

        // -- Stat visibility toggles ------------------------------------------

        const statRowMap = {
            eggs:     { el: $("statEggs"),     key: "showStatEggs",            get: () => showStatEggs,            set: v => { showStatEggs = v; } },
            carrots:  { el: $("statCarrots"),  key: "showStatCarrots",         get: () => showStatCarrots,         set: v => { showStatCarrots = v; } },
            arrival:  { el: $("statDuration"), key: "showStatArrivalEstimate", get: () => showStatArrivalEstimate, set: v => { showStatArrivalEstimate = v; } },
            last:     { el: $("statLast"),     key: "showStatLastSpotted",     get: () => showStatLastSpotted,     set: v => { showStatLastSpotted = v; } },
            speed:    { el: $("statSpeed"),    key: "showStatSpeed",           get: () => showStatSpeed,           set: v => { showStatSpeed = v; } },
        };

        const statBtnIds = {
            eggs:    "toggleStatEggs",
            carrots: "toggleStatCarrots",
            arrival: "toggleStatArrival",
            last:    "toggleStatLast",
            speed:   "toggleStatSpeed",
        };

        const statLabels = {
            eggs:    "Eggs Delivered",
            carrots: "Carrots Eaten",
            arrival: "Arrival Estimate",
            last:    "Last Spotted",
            speed:   "Traveling Speed",
        };

        function applyStatVisibility() {
            for (const [name, info] of Object.entries(statRowMap)) {
                const row = info.el?.closest(".hud-row");
                if (row) row.style.display = info.get() ? "" : "none";
            }
        }

        function updateStatToggleButtons() {
            for (const [name, btnId] of Object.entries(statBtnIds)) {
                const btn = $(btnId);
                if (!btn) continue;
                const shown = statRowMap[name].get();
                btn.setAttribute("aria-pressed", String(shown));
                btn.textContent = `${statLabels[name]}: ${shown ? "Shown" : "Hidden"}`;
            }
        }

        for (const [name, btnId] of Object.entries(statBtnIds)) {
            const btn = $(btnId);
            if (!btn) continue;
            btn.addEventListener("click", () => {
                const info = statRowMap[name];
                const next = !info.get();
                info.set(next);
                saveSettings({ [info.key]: next });
                applyStatVisibility();
                updateStatToggleButtons();
            });
        }

        applyStatVisibility();
        updateStatToggleButtons();

        // -- Bunny hop animation toggle ----------------------------------------

        let bunnyImgEl = bunnyMarker?.getElement()?.querySelector("img");

        function updateBunnyHopButton() {
            const btn = $("bunnyHopBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(bunnyHopEnabled));
            btn.textContent = bunnyHopEnabled ? "Bunny Hop Animation: On" : "Bunny Hop Animation: Off";
        }

        function applyBunnyHop(isTraveling) {
            if (!bunnyImgEl) bunnyImgEl = bunnyMarker?.getElement()?.querySelector("img");
            if (!bunnyImgEl) return;
            const shouldHop = bunnyHopEnabled && isTraveling;
            bunnyImgEl.classList.toggle("bunny-hop-active", shouldHop);
        }

        const bunnyHopBtn = $("bunnyHopBtn");
        if (bunnyHopBtn) {
            bunnyHopBtn.addEventListener("click", () => {
                bunnyHopEnabled = !bunnyHopEnabled;
                saveSettings({ bunnyHopEnabled });
                updateBunnyHopButton();
            });
        }
        updateBunnyHopButton();

        // -- Travel trails ----------------------------------------------------

        function initTrailLayer() {
            if (map.getSource("travel-trail")) return;
            map.addSource("travel-trail", {
                type: "geojson",
                data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } }
            });
            map.addLayer({
                id: "travel-trail-line",
                type: "line",
                source: "travel-trail",
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                    "line-color": "#c8a8f5",
                    "line-width": 3,
                    "line-opacity": 0.6
                }
            });
        }

        // Throttle full trail rebuilds — coords only change meaningfully a few
        // times per second, but the tick loop calls this every 100 ms.
        let _trailLastLon = null;
        let _trailLastLat = null;
        let _trailLastBuiltMs = 0;
        const _TRAIL_REBUILD_MS = 500;
        const _TRAIL_MIN_DELTA_DEG = 0.02; // ~2 km — sub-pixel changes aren't worth a setData

        function updateTrailLine(now, currentLon, currentLat) {
            if (!travelTrailsEnabled) {
                if (map.getLayer("travel-trail-line")) {
                    map.setLayoutProperty("travel-trail-line", "visibility", "none");
                }
                return;
            }

            if (!map.getSource("travel-trail")) initTrailLayer();
            map.setLayoutProperty("travel-trail-line", "visibility", "visible");

            // Skip the rebuild if neither time nor position has moved enough to
            // matter. setData triggers a full source re-tile/re-draw, which is
            // expensive when stacked on top of the 3D layer.
            const nowMs = (typeof performance !== "undefined" && performance.now)
                ? performance.now() : Date.now();
            const movedEnough =
                _trailLastLon === null ||
                Math.abs((currentLon ?? _trailLastLon) - _trailLastLon) > _TRAIL_MIN_DELTA_DEG ||
                Math.abs((currentLat ?? _trailLastLat) - _trailLastLat) > _TRAIL_MIN_DELTA_DEG;
            if (!movedEnough && nowMs - _trailLastBuiltMs < _TRAIL_REBUILD_MS) return;
            _trailLastBuiltMs = nowMs;
            if (currentLon !== undefined) _trailLastLon = currentLon;
            if (currentLat !== undefined) _trailLastLat = currentLat;

            // Build the trail from all departed stops plus the current position
            const coords = [];
            let prevLon = null;

            for (const s of stops) {
                if (now < s.UnixArrivalArrival) break;
                let lon = s.Longitude;
                // Unwrap for antimeridian continuity
                if (prevLon !== null) {
                    while (lon - prevLon > 180) lon -= 360;
                    while (lon - prevLon < -180) lon += 360;
                }
                coords.push([lon, s.Latitude]);
                prevLon = lon;
            }

            // Append the current interpolated position (during travel)
            if (currentLon !== undefined && currentLat !== undefined) {
                let lon = currentLon;
                if (prevLon !== null) {
                    while (lon - prevLon > 180) lon -= 360;
                    while (lon - prevLon < -180) lon += 360;
                }
                coords.push([lon, currentLat]);
            }

            if (coords.length >= 2) {
                map.getSource("travel-trail").setData({
                    type: "Feature",
                    geometry: { type: "LineString", coordinates: coords }
                });
            }
        }

        function updateTravelTrailsButton() {
            const btn = $("travelTrailsBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(travelTrailsEnabled));
            btn.textContent = travelTrailsEnabled ? "Travel Trails: On" : "Travel Trails: Off";
        }

        const travelTrailsBtn = $("travelTrailsBtn");
        if (travelTrailsBtn) {
            travelTrailsBtn.addEventListener("click", () => {
                travelTrailsEnabled = !travelTrailsEnabled;
                saveSettings({ travelTrailsEnabled });
                updateTravelTrailsButton();
            });
        }
        updateTravelTrailsButton();

        // Re-add trail layer after style changes (style.load clears all layers)
        map.on("style.load", () => {
            if (travelTrailsEnabled && !map.getSource("travel-trail")) {
                initTrailLayer();
            }
        });

        // -- Lock button ------------------------------------------------------

        const lockBtn = $("lockBtn");
        if (lockBtn) lockBtn.addEventListener("click", () => setLocked(!isLocked));

        // -- Left-click orbit for 3D locked mode --------------------------------
        // Mapbox dragRotate only works with right-click. This adds left-click
        // drag-to-orbit when locked in 3D, since dragPan is disabled anyway.
        {
            let orbitActive = false;
            let orbitLastX = 0;
            let orbitLastY = 0;

            const canvas = map.getCanvas();

            canvas.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return; // left button only
                if (!isLocked || !tracking3dEnabled || !journey3dActivated) return;
                orbitActive = true;
                orbitLastX = e.clientX;
                orbitLastY = e.clientY;
                canvas.style.cursor = "grabbing";
                e.preventDefault();
            });

            window.addEventListener("mousemove", (e) => {
                if (!orbitActive) return;
                const dx = e.clientX - orbitLastX;
                const dy = e.clientY - orbitLastY;
                orbitLastX = e.clientX;
                orbitLastY = e.clientY;

                const bearing = map.getBearing() - dx * 0.4;
                const pitch = Math.min(TRACKING_3D_ORBIT_PITCH_MAX,
                    Math.max(TRACKING_3D_ORBIT_PITCH_MIN, map.getPitch() - dy * 0.3));
                // Re-frame on the bunny for the new angle so he stays centered
                // while orbiting, instead of the camera swinging around the
                // ground point beneath him.
                map.jumpTo({ bearing, pitch, center: framingCenterAt(bearing, pitch) });
            });

            window.addEventListener("mouseup", (e) => {
                if (e.button !== 0 || !orbitActive) return;
                orbitActive = false;
                canvas.style.cursor = "";
            });

            // Gentle scroll-to-zoom while locked in 3D. Mapbox's own scrollZoom
            // is disabled in locked mode, so drive it by hand: a small step per
            // wheel delta, clamped to a tight range so the bunny stays framed,
            // and re-center on him each time (he's on the center ray, so zoom
            // keeps him put — but re-framing covers any orbited angle too).
            canvas.addEventListener("wheel", (e) => {
                if (!isLocked || !tracking3dEnabled || !journey3dActivated) return;
                e.preventDefault();
                // userZoom3d is a BASE (equator) zoom; the latitude compensation
                // is applied in getLockedZoom(). Adjust and clamp the base, then
                // apply the compensated result.
                const base = (userZoom3d !== null) ? userZoom3d : TRACKING_3D_LOCKED_ZOOM;
                const next = base - e.deltaY * TRACKING_3D_WHEEL_ZOOM_RATE;
                userZoom3d = Math.min(TRACKING_3D_USER_ZOOM_MAX,
                    Math.max(TRACKING_3D_USER_ZOOM_MIN, next));
                map.jumpTo({
                    zoom: getLockedZoom(),
                    center: framingCenterAt(map.getBearing(), map.getPitch())
                });
            }, { passive: false });
        }

        // -- City info toggle button ------------------------------------------
        // Hidden during countdown (DR < 77), visible once the journey begins.

        // Default true - only false if the user explicitly hid it last session
        let cityInfoUserVisible = localStorage.getItem("eb_cityInfo_visible_v1") !== "0";

        function updateCityInfoToggleBtn() {
            const btn = $("cityInfoToggleBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(cityInfoUserVisible));
            btn.textContent = cityInfoUserVisible ? "\uD83C\uDFD9\uFE0F Hide City Info" : "\uD83C\uDFD9\uFE0F Show City Info";
            btn.title = cityInfoUserVisible ? "Hide city info panel" : "Show city info panel";
        }

        const cityInfoToggleBtn = $("cityInfoToggleBtn");
        if (cityInfoToggleBtn) {
            cityInfoToggleBtn.addEventListener("click", () => {
                cityInfoUserVisible = !cityInfoUserVisible;
                localStorage.setItem("eb_cityInfo_visible_v1", cityInfoUserVisible ? "1" : "0");
                updateCityInfoToggleBtn();
                if (!cityInfoUserVisible && cityPanel) cityPanel.hidden = true;
            });
        }
        updateCityInfoToggleBtn();

        // -- Help modal -------------------------------------------------------

        const helpBtn = $("helpBtn");
        const helpOverlay = $("helpOverlay");
        const helpCloseBtn = $("helpCloseBtn");

        function openHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.add("is-open");
            helpOverlay.setAttribute("aria-hidden", "false");
            helpOverlay.querySelector(".help-tab.is-active")?.focus();
        }

        function closeHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.remove("is-open");
            helpOverlay.setAttribute("aria-hidden", "true");
            helpBtn?.focus();
        }

        function setHelpTab(tabKey) {
            if (!helpOverlay) return;
            helpOverlay.querySelectorAll(".help-tab").forEach(t => t.classList.toggle("is-active", t.dataset.tab === tabKey));
            helpOverlay.querySelectorAll(".help-pane").forEach(p => p.classList.toggle("is-active", p.dataset.pane === tabKey));

            // Lazily load the Ko-fi donation iframe the first time the Donate
            // tab is opened, instead of on every page view.
            if (tabKey === "donate") {
                const kofi = $("kofiframe");
                if (kofi && !kofi.src && kofi.dataset.src) kofi.src = kofi.dataset.src;
            }
        }

        if (helpBtn) helpBtn.addEventListener("click", openHelp);
        if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelp);

        // FIX: wire up the backdrop click to close the modal
        helpOverlay?.querySelector(".help-backdrop")?.addEventListener("click", closeHelp);

        helpOverlay?.querySelector(".help-tabs")?.addEventListener("click", e => {
            const btn = e.target.closest(".help-tab");
            if (btn) { e.preventDefault(); setHelpTab(btn.dataset.tab); }
        });

        window.addEventListener("keydown", e => {
            if (e.key === "Escape" && helpOverlay?.classList.contains("is-open")) closeHelp();
        });

        // -- Background music -------------------------------------------------

        let musicEnabled = typeof initialSettings.musicEnabled === "boolean"
            ? initialSettings.musicEnabled
            : true;
        let bgAudio = null;
        let musicResumePending = false;

        function initBgMusic() {
            if (bgAudio) return;

            bgAudio = new Audio("assets/audio/music.mp3");
            bgAudio.loop = false;
            bgAudio.volume = MUSIC_VOLUME;

            bgAudio.addEventListener("ended", () => {
                if (!musicEnabled) return;
                setTimeout(() => {
                    if (!musicEnabled || !bgAudio) return;
                    try {
                        bgAudio.currentTime = 0;
                        bgAudio.play()
                            ?.then(() => { musicResumePending = false; })
                            ?.catch(() => { musicResumePending = true; });
                    } catch { musicResumePending = true; }
                }, 1000);
            });

            if (!musicEnabled) return;

            try {
                bgAudio.play()
                    ?.then(() => { musicResumePending = false; })
                    ?.catch(err => {
                        console.warn("Autoplay blocked:", err);
                        musicResumePending = true;
                    });
            } catch { musicResumePending = true; }
        }

        function setMusicEnabled(next) {
            musicEnabled = !!next;
            saveSettings({ musicEnabled });

            const btn = $("musicToggleBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(musicEnabled));
                btn.textContent = musicEnabled ? "Music: On" : "Music: Off";
            }

            if (!bgAudio) { if (musicEnabled) initBgMusic(); return; }

            if (musicEnabled) {
                try {
                    bgAudio.play()
                        ?.then(() => { musicResumePending = false; })
                        ?.catch(() => { musicResumePending = true; });
                } catch { musicResumePending = true; }
            } else {
                bgAudio.pause();
                musicResumePending = false;
            }
        }

        function handleUserInteractionForMusic() {
            if (!musicEnabled || !bgAudio || !musicResumePending) return;
            musicResumePending = false;
            try { bgAudio.play()?.catch(() => { }); } catch { }
        }

        ["pointerdown", "click", "keydown", "touchstart"].forEach(ev => {
            window.addEventListener(ev, handleUserInteractionForMusic, { passive: true });
        });

        const musicToggleBtn = $("musicToggleBtn");
        if (musicToggleBtn) {
            musicToggleBtn.addEventListener("click", () => {
                setMusicEnabled(!musicEnabled);
                if (musicEnabled && !bgAudio) initBgMusic();
            });
        }

        setMusicEnabled(musicEnabled);
        initBgMusic();

        // -- Tick loop --------------------------------------------------------

        function tick() {
            const now = serverNowSec();
            isDelivering = false;

            const seg = findSegment(now, stops, TAKEOFF_ARRIVAL);

            speedJitter += (Math.random() - 0.5) * 0.8;
            speedJitter = Math.max(-3, Math.min(3, speedJitter));

            // Update currentSegDR so getLockedZoom() always reflects the current phase
            currentSegDR =
                seg.mode === "stop" ? Number(stops[seg.i]?.DR ?? null) :
                    seg.mode === "travel" ? Number(stops[seg.to]?.DR ?? null) :
                        null;

            // Track the most recent travel destination for city panel continuity
            let newTravelSegment = false;
            if (seg.mode === "travel") {
                const isNew = lastSegMode !== "travel" || lastSegToIndex !== seg.to;
                newTravelSegment = isNew;
                if (isNew && stops[seg.to]) currentCityStop = stops[seg.to];
                lastSegMode = "travel";
                lastSegToIndex = seg.to;
            } else {
                lastSegMode = seg.mode;
                lastSegToIndex = null;
            }

            // Drop a basket marker for every stop the bunny has already departed.
            // Fall back to the arrival time when a stop is missing
            // UnixArrivalDeparture (some pre-takeoff stops omit it). Without
            // this, the NaN comparison would break the loop early and skip
            // baskets for every subsequent stop.
            for (const s of stops) {
                const departed = Number.isFinite(s.UnixArrivalDeparture)
                    ? s.UnixArrivalDeparture
                    : s.UnixArrivalArrival;
                if (!Number.isFinite(departed)) continue;
                if (now >= departed) addBasketForStop(s);
                else break;
            }
            flushBaskets();   // one setData per tick, only if anything was added

            // -- Journey complete ---------------------------------------------
            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                // Revert to 2D when the journey is over
                deactivate3dJourney();
                setActiveLeg(null, null);

                if (cityPanel) cityPanel.hidden = true;

                updateBunnyPosition(finalStop.Longitude, finalStop.Latitude);
                applyBunnyHop(false);
                set3dBunnyTraveling(false);

                if (statEtaRow) statEtaRow.style.display = "none";

                currentSegDR = FINAL_DR;

                updateHUD({
                    status: "Easter Island, Chile - The Easter Bunny has completed his journey", lastText: "\u2014",
                    etaSeconds: NaN, etaText: "", stopRemainingSeconds: NaN,
                    speedKmh: NaN, speedMph: NaN,
                    eggs: finalStop.EggsDelivered, carrots: finalStop.CarrotsEaten
                });

                followBunnyIfLocked();
                updateViewerLocationEta(now);
                return;
            }

            // Shared phase flags used across all modes below
            const before76 = isBeforeDR76ForSegment(seg, stops);
            const before77 = isBeforeDR77ForSegment(seg, stops);
            setEtaLabel(before76);
            setViewerEtaVisibility(!before77);
            setStopRemainingVisibility(!before77);

            // -- Pre-journey --------------------------------------------------
            if (seg.mode === "pre") {
                // Pre-journey stays 2D
                deactivate3dJourney();
                setActiveLeg(null, null);
                dismissLoading();

                const first = stops[0];
                updateBunnyPosition(first.Longitude, first.Latitude);
                applyBunnyHop(false);
                set3dBunnyTraveling(false);

                updateHUD({
                    status: "Preparing for takeoff\u2026",
                    lastText: "N/A",
                    etaSeconds: etaForHUD(now, first.UnixArrivalArrival - now, TAKEOFF_ARRIVAL),
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN, speedMph: NaN,
                    eggs: 0, carrots: 0
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
                updateViewerLocationEta(now);
                updateCityPanel(now, seg);
                return;
            }

            // Activate 3D globe at takeoff (DR >= 76) if user has 3D tracking enabled.
            // Placed after journey-complete and pre-journey exits so those phases
            // always stay in 2D.
            if (!journey3dActivated && tracking3dEnabled &&
                currentSegDR !== null && currentSegDR >= TAKEOFF_DR) {
                activate3dJourney();
            }

            // -- At a stop ----------------------------------------------------
            if (seg.mode === "stop") {
                setActiveLeg(null, null);   // static — the motion loop idles

                const s = stops[seg.i];
                const next = stops[Math.min(seg.i + 1, stops.length - 1)];
                const drNow = Number(s.DR);

                // Special case: DR 76 takeoff clearance stop
                if (Number.isFinite(drNow) && drNow === TAKEOFF_DR) {
                    isDelivering = false;
                    updateBunnyPosition(s.Longitude, s.Latitude);
                    applyBunnyHop(false);
                    set3dBunnyTraveling(false);

                    const nextA = next ? Number(next.UnixArrivalArrival) : NaN;
                    updateHUD({
                        status: "Takeoff clearance granted \u2014 lifting off!",
                        lastText: "N/A",
                        etaSeconds: Number.isFinite(nextA) ? nextA - now : NaN,
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN, speedMph: NaN,
                        eggs: 0, carrots: 0
                    });

                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }

                const preTakeoffStop = Number.isFinite(drNow) && drNow < TAKEOFF_DR;
                isDelivering = !preTakeoffStop;
                if (isDelivering) ensureEggAnimation();
                updateBunnyPosition(s.Longitude, s.Latitude);
                applyBunnyHop(false);
                set3dBunnyTraveling(false);
                // The bunny now eases down to the ground; keep the smooth follow
                // loop running so the camera re-frames cleanly through the
                // descent instead of stepping at the 10 Hz tick rate.
                ensureMotionLoop();
                updateTrailLine(now, s.Longitude, s.Latitude);

                // Pre-takeoff preparation stop
                if (preTakeoffStop) {
                    updateHUD({
                        status: s.City || "Preparing\u2026",
                        lastText: "N/A",
                        etaSeconds: etaForHUD(now, NaN, TAKEOFF_ARRIVAL),
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN, speedMph: NaN,
                        eggs: 0, carrots: 0
                    });

                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }

                // Active delivery stop -- calculate speed from previous leg and interpolate totals
                const stopRemaining = s.UnixArrivalDeparture - now;
                let speedKmh = NaN, speedMph = NaN;
                let prevEggs = 0, prevCarrots = 0;

                if (seg.i > 0) {
                    const prev = stops[seg.i - 1];
                    const distKm = haversineKm(prev.Latitude, prev.Longitude, s.Latitude, s.Longitude);
                    const travelSec = Math.max(1, s.UnixArrivalArrival - prev.UnixArrivalDeparture);
                    speedKmh = (distKm / travelSec) * 3600;
                    speedMph = speedKmh * 0.621371;
                    prevEggs = Number(prev.EggsDelivered) || 0;
                    prevCarrots = Number(prev.CarrotsEaten) || 0;
                }

                const cityEggs = Number(s.EggsDelivered) || prevEggs;
                const cityCarrots = Number(s.CarrotsEaten) || prevCarrots;
                const stopDuration = Math.max(1, s.UnixArrivalDeparture - s.UnixArrivalArrival);
                const stopT = clamp01((now - s.UnixArrivalArrival) / stopDuration);

                // The flight here already credited TRAVEL_STATS_SHARE of this
                // city's delta (see the travel branch) — the stop seamlessly
                // finishes the remainder, so the count never jumps or stalls.
                const startEggs = lerp(prevEggs, cityEggs, TRAVEL_STATS_SHARE);
                const startCarrots = lerp(prevCarrots, cityCarrots, TRAVEL_STATS_SHARE);

                updateHUD({
                    status: `Delivering in ${s.City}`,
                    lastText: before77 ? "N/A" : (seg.i > 0 ? cityLabel(stops[seg.i - 1]) : "\u2014"),
                    etaText: `Currently delivering eggs in ${s.City}`,
                    etaSeconds: NaN,
                    stopRemainingSeconds: stopRemaining,
                    speedKmh: Number.isFinite(speedKmh) ? speedKmh + speedJitter : NaN,
                    speedMph: Number.isFinite(speedMph) ? speedMph + speedJitter : NaN,
                    eggs: lerp(startEggs, cityEggs, stopT),
                    carrots: lerp(startCarrots, cityCarrots, stopT)
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
            }

            // -- Travelling between stops -------------------------------------
            else if (seg.mode === "travel") {
                const from = stops[seg.from];
                const to = stops[seg.to];
                if (!from || !to) return;

                // Hand smooth per-frame position + camera-follow to the motion loop
                setActiveLeg(from, to);

                if ([from.Latitude, from.Longitude, to.Latitude, to.Longitude].every(Number.isFinite)) {
                    currentTravelBearingDeg = bearingDeg(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                }

                // Reset camera to default angles when a new travel segment begins (3D)
                if (newTravelSegment && isLocked && tracking3dEnabled && journey3dActivated && !introAnimPlaying) {
                    relockAnimating = true;
                    map.easeTo({
                        center: framingCenter(),
                        zoom: getLockedZoom(),
                        pitch: getLockedPitch(),
                        bearing: getLockedBearing(),
                        duration: 1000
                    });
                    setTimeout(() => { relockAnimating = false; }, 1050);
                }

                const toDr = Number(to.DR);
                const preTakeoffTravel = Number.isFinite(toDr) && toDr < TAKEOFF_DR;
                const showRegion = Number.isFinite(toDr) && toDr >= 76;
                const destLabel = showRegion ? cityLabel(to) : cityOnly(to);
                const statusText = preTakeoffTravel ? (to.City || "Preparing\u2026") : `Heading to: ${destLabel}`;

                const departT = from.UnixArrivalDeparture;
                const arriveT = to.UnixArrivalArrival;
                const denom = Math.max(1, arriveT - departT);
                const t = clamp01((now - departT) / denom);
                const pos = interpolateLatLon(from, to, t);

                updateBunnyPosition(pos.lon, pos.lat);
                applyBunnyHop(true);
                set3dBunnyTraveling(true);
                set3dBunnyHeading(currentTravelBearingDeg);
                updateTrailLine(now, pos.lon, pos.lat);

                const distKm = haversineKm(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                const speedKmh = preTakeoffTravel ? NaN : (distKm / denom) * 3600;
                const speedMph = preTakeoffTravel ? NaN : speedKmh * 0.621371;

                // Counts keep rising en route: credit TRAVEL_STATS_SHARE of the
                // destination city's delta across the flight (the stop finishes
                // the rest — see the stop branch).
                const fromEggs = Number(from.EggsDelivered) || 0;
                const toEggs = Number(to.EggsDelivered) || fromEggs;
                const fromCarrots = Number(from.CarrotsEaten) || 0;
                const toCarrots = Number(to.CarrotsEaten) || fromCarrots;

                updateHUD({
                    status: statusText,
                    lastText: before77 ? "N/A" : cityLabel(from),
                    etaSeconds: etaForHUD(now, arriveT - now, TAKEOFF_ARRIVAL),
                    stopRemainingSeconds: NaN,
                    speedKmh: Number.isFinite(speedKmh) ? speedKmh + speedJitter : NaN,
                    speedMph: Number.isFinite(speedMph) ? speedMph + speedJitter : NaN,
                    eggs: preTakeoffTravel ? 0 : lerp(fromEggs, toEggs, t * TRAVEL_STATS_SHARE),
                    carrots: preTakeoffTravel ? 0 : lerp(fromCarrots, toCarrots, t * TRAVEL_STATS_SHARE)
                });

                // Camera follow happens in the smooth motion loop while traveling
                currentTravelDirection = computeTravelDirection(from, to);
            }

            updateViewerLocationEta(now);
            updateCityPanel(now, seg);
        }

        // -- Start ------------------------------------------------------------

        tick();
        // Store the interval reference so it can be cleared later if needed
        const _tickInterval = setInterval(tick, 100);

        console.log(`Loaded route with ${stops.length} stops (Mapbox globe).`);

    } catch (e) {
        console.error("Tracker init failed:", e);
        const el = document.getElementById("statStatus");
        if (el) el.textContent = "Error (see console)";
        // Dismiss loading overlay so the error message is visible
        const overlay = document.getElementById("loadingOverlay");
        if (overlay && !overlay.hidden) {
            overlay.classList.add("fade-out");
            setTimeout(() => { overlay.hidden = true; }, 900);
        }
    }
})();