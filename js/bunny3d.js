/* =============================================================================
 *  Easter Bunny Tracker  -  bunny3d.js
 *
 *  8. Decoupled 3D bunny renderer
 *
 *  Renders the animated GLB bunny on its OWN transparent canvas with its OWN
 *  WebGL context, layered directly over the Mapbox canvas. This is the key
 *  performance fix over the old design:
 *
 *    OLD: the bunny lived inside a Mapbox custom layer, so animating him
 *         required map.triggerRepaint() — a full re-render of every map
 *         layer (tiles, lighting, labels, globe) at 24 fps, even when the
 *         camera and bunny were perfectly still.
 *
 *    NEW: the map only re-renders when the camera actually moves (Mapbox's
 *         own logic). The bunny animates independently on his cheap little
 *         scene (one model, one draw call) at a capped frame rate.
 *
 *  Staying pixel-locked to the globe: a tiny NO-OP custom layer ("matrix
 *  probe") is registered with Mapbox purely to capture the view-projection
 *  matrix every time the map renders. When the camera moves, the probe fires
 *  and we redraw the bunny synchronously in the same frame — so there is no
 *  one-frame "swim" between the ground and the model. Between map renders the
 *  cached matrix stays valid (it only depends on the camera), so the bunny
 *  can redraw at any rate without touching the map.
 *
 *  NOTE: the projection matrix is only a plain mercator matrix at zooms
 *  where Mapbox's globe has transitioned to mercator rendering (>= ~6).
 *  The zoomThreshold option (7 by default) keeps us safely inside that
 *  range — below it, callers should show the 2D sprite instead.
 *
 *  Public API (all methods safe to call before the GLB finishes loading):
 *    const bunny3d = createBunny3D(map, opts)   // null if THREE is missing
 *      .setEnabled(bool)     — 3D journey active (master visibility gate)
 *      .setPosition(lon,lat) — world position (called every motion frame)
 *      .setHeading(deg)      — compass bearing, 0 = north, CW
 *      .setTraveling(bool)   — cross-fades walk/idle animations
 *      .setTargetFps(fps)    — cap for self-driven redraws (default 30)
 *      .isLoaded() / .isVisible()
 *      .destroy()
 * ============================================================================= */

"use strict";

function createBunny3D(map, opts) {
    if (typeof THREE === "undefined") {
        console.warn("[3D] Three.js not loaded — 3D bunny unavailable.");
        return null;
    }

    const modelUrl = opts.modelUrl;
    const modelScale = opts.scale;
    const zoomThreshold = opts.zoomThreshold;
    const flightAltitude = opts.flightAltitude;
    // Per-model yaw correction (degrees): compensates for a model whose native
    // "forward" isn't the axis the base rotation assumes, so he actually faces
    // the direction of travel.
    const headingOffsetRad = (opts.headingOffsetDeg || 0) * Math.PI / 180;
    const onVisibilityChange = opts.onVisibilityChange || function () { };
    const onLoaded = opts.onLoaded || function () { };

    // -- State ----------------------------------------------------------------

    let enabled = false;        // journey-level gate (setEnabled)
    let loaded = false;         // GLB finished loading
    let visible = false;        // enabled && loaded && zoom >= threshold
    let destroyed = false;

    const lngLat = [0, 0];
    let headingRad = 0;
    let traveling = false;

    // Current altitude (meters), eased toward flightAltitude while traveling
    // and toward 0 while at a stop — so he lands to deliver and lifts off to
    // fly, instead of permanently hovering mid-air.
    let altitude = 0;

    let targetFrameMs = 1000 / 30;   // self-driven redraw cap (~30 fps)
    let lastDrawMs = 0;
    let rafId = null;

    let bottomOffset = 0;       // meters the model extends below its pivot
    let modelHalfHeight = 0;    // meters from the model's feet to its vertical center

    // Latest Mapbox view-projection matrix, copied out of the probe layer.
    const mapMatrix = new Float64Array(16);
    let haveMatrix = false;

    // -- Overlay canvas + renderer ---------------------------------------------

    const mapCanvas = map.getCanvas();

    const canvas = document.createElement("canvas");
    canvas.className = "bunny3d-overlay";
    // Sits directly above the map canvas; DOM markers (baskets, popups) are
    // appended after it in the same container, so they stay on top — same
    // stacking order as the old in-map custom layer.
    canvas.style.cssText =
        "position:absolute;top:0;left:0;width:100%;height:100%;" +
        "pointer-events:none;display:none;";
    mapCanvas.parentNode.insertBefore(canvas, mapCanvas.nextSibling);

    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        // MSAA only costs us our own tiny scene now (not the whole map),
        // and it makes the model edges dramatically cleaner at pixelRatio 1.
        antialias: true
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.sortObjects = false;
    renderer.shadowMap.enabled = false;

    function resize() {
        // Match the map's CSS size; keep our own CSS at 100% (setSize's
        // updateStyle=false leaves the stylesheet alone).
        renderer.setSize(mapCanvas.clientWidth, mapCanvas.clientHeight, false);
    }
    resize();

    // -- Scene ------------------------------------------------------------------

    const camera = new THREE.Camera();
    const scene = new THREE.Scene();

    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0, 70, 100);
    scene.add(dirLight);

    let model = null;
    let mixer = null;
    let walkAction = null;
    let idleAction = null;
    const clock = new THREE.Clock();

    // Pre-allocated scratch objects — no per-frame garbage.
    const _zAxis = new THREE.Vector3(0, 0, 1);
    const _scaleVec = new THREE.Vector3();
    const _rotMat = new THREE.Matrix4();
    const _projMat = new THREE.Matrix4();
    const _localMat = new THREE.Matrix4();

    const loader = new THREE.GLTFLoader();
    loader.load(modelUrl, (gltf) => {
        if (destroyed) return;

        model = gltf.scene;
        model.scale.set(modelScale, modelScale, modelScale);
        // Stand the model upright (GLB Y-up -> Mapbox Z-up)
        model.rotation.x = Math.PI / 2;
        scene.add(model);

        // Measure how far the model extends below its pivot in world-up
        // (Mapbox Z) so his feet ride at the intended altitude instead of
        // his centroid.
        model.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(model);
        if (Number.isFinite(bbox.min.z)) bottomOffset = Math.max(0, -bbox.min.z);
        // Half the model's world-up height (meters). The camera uses this to
        // frame the model's VERTICAL CENTER instead of its feet — otherwise a
        // tall model (scale 90 makes him ~4 km tall) sits with his body above
        // the center ray and his head clipped off the top of the screen.
        if (Number.isFinite(bbox.min.z) && Number.isFinite(bbox.max.z)) {
            modelHalfHeight = Math.max(0, (bbox.max.z - bbox.min.z) / 2);
        }

        // Strip per-mesh features we never use.
        model.traverse(child => {
            if (child.isMesh) {
                child.castShadow = false;
                child.receiveShadow = false;
                child.frustumCulled = true;
                if (child.material) child.material.fog = false;
            }
        });

        if (gltf.animations && gltf.animations.length > 0) {
            mixer = new THREE.AnimationMixer(model);
            for (const clip of gltf.animations) {
                const name = clip.name.toLowerCase();
                if (name.includes("walk")) {
                    walkAction = mixer.clipAction(clip);
                    walkAction.loop = THREE.LoopRepeat;
                } else if (name.includes("idle")) {
                    idleAction = mixer.clipAction(clip);
                    idleAction.loop = THREE.LoopRepeat;
                }
            }
            const startAction = traveling ? (walkAction || idleAction) : (idleAction || walkAction);
            if (startAction) startAction.play();
        }

        clock.start();
        loaded = true;
        updateVisibility();
        onLoaded();
    }, undefined, (err) => {
        console.warn("[3D] Failed to load bunny model:", err);
    });

    // -- Drawing -----------------------------------------------------------------

    function draw(nowMs) {
        if (!visible || !loaded || !haveMatrix) return;
        lastDrawMs = nowMs;

        // Advance animations by real elapsed time (capped so a background
        // tab doesn't fast-forward the skeleton on return).
        const delta = Math.min(clock.getDelta(), 0.1);
        if (mixer) mixer.update(delta);

        // Ease altitude: lift off when traveling, touch down at stops
        // (~1.5 s exponential approach, frame-rate independent).
        const targetAlt = traveling ? flightAltitude : 0;
        if (altitude !== targetAlt) {
            altitude += (targetAlt - altitude) * (1 - Math.exp(-2.5 * delta));
            if (Math.abs(targetAlt - altitude) < 1) altitude = targetAlt;
        }

        const merc = mapboxgl.MercatorCoordinate.fromLngLat(
            { lng: lngLat[0], lat: lngLat[1] }, bottomOffset + altitude
        );
        const s = merc.meterInMercatorCoordinateUnits();

        _rotMat.makeRotationAxis(_zAxis, headingRad);
        _scaleVec.set(s, -s, s);   // -Y flips handedness (mercator Y grows south)

        _localMat
            .makeTranslation(merc.x, merc.y, merc.z)
            .scale(_scaleVec)
            .multiply(_rotMat);

        _projMat.fromArray(mapMatrix).multiply(_localMat);
        camera.projectionMatrix = _projMat;

        renderer.render(scene, camera);
    }

    // Self-driven loop: keeps the idle/walk animation alive at the capped
    // rate while the map itself is idle. Costs one small draw call per frame.
    function loopFrame(ts) {
        rafId = null;
        if (!visible || destroyed) return;
        rafId = requestAnimationFrame(loopFrame);
        if (document.hidden) return;
        // The probe may have just drawn in the same vsync (camera moving) —
        // the throttle below naturally skips those frames.
        if (ts - lastDrawMs >= targetFrameMs) draw(ts);
    }

    function startLoop() {
        if (rafId === null) rafId = requestAnimationFrame(loopFrame);
    }

    function stopLoop() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    // -- Matrix probe layer --------------------------------------------------------
    // A do-nothing custom layer whose only job is to hand us the current
    // view-projection matrix whenever Mapbox renders a frame. When the camera
    // is moving we redraw the bunny right here, inside the same frame, so the
    // model never lags the ground.

    const PROBE_ID = "bunny3d-matrix-probe";
    const probeLayer = {
        id: PROBE_ID,
        type: "custom",
        renderingMode: "2d",
        onAdd() { },
        render(gl, matrix) {
            if (destroyed) return;
            mapMatrix.set(matrix);
            haveMatrix = true;
            if (visible && loaded) draw(performance.now());
        }
    };

    function ensureProbeLayer() {
        try {
            if (!map.getLayer(PROBE_ID)) map.addLayer(probeLayer);
        } catch (e) {
            console.warn("[3D] Failed to add matrix probe layer:", e);
        }
    }
    ensureProbeLayer();

    // -- Visibility --------------------------------------------------------------

    function updateVisibility() {
        const show = enabled && loaded && map.getZoom() >= zoomThreshold;
        if (show === visible) return;
        visible = show;
        canvas.style.display = show ? "" : "none";
        onVisibilityChange(show);
        if (show) {
            clock.getDelta();       // drain accumulated time so anims don't jump
            altitude = traveling ? flightAltitude : 0;   // snap — don't animate into view
            map.triggerRepaint();   // one repaint to refresh the cached matrix
            startLoop();
        } else {
            stopLoop();
        }
    }

    // -- Map event wiring -----------------------------------------------------------

    const onZoom = () => updateVisibility();
    const onResize = () => resize();
    const onStyleLoad = () => ensureProbeLayer();   // style.load wipes layer registrations

    map.on("zoom", onZoom);
    map.on("resize", onResize);
    map.on("style.load", onStyleLoad);

    // -- Public API -------------------------------------------------------------------

    return {
        setEnabled(v) {
            enabled = !!v;
            updateVisibility();
        },

        setPosition(lon, lat) {
            lngLat[0] = lon;
            lngLat[1] = lat;
        },

        setHeading(bearingDegrees) {
            // bearing: 0 = north, 90 = east (CW from north).
            // In Mapbox mercator: north = -Y, east = +X. The PI offset corrects
            // for the model's native forward, then subtract the bearing
            // (CW rotation viewed from above).
            headingRad = Math.PI + headingOffsetRad - (bearingDegrees * Math.PI / 180);
        },

        setTraveling(v) {
            const next = !!v;
            if (next === traveling) return;
            traveling = next;
            if (!mixer) return;
            if (traveling) {
                if (idleAction) idleAction.fadeOut(0.3);
                if (walkAction) walkAction.reset().fadeIn(0.3).play();
            } else {
                if (walkAction) walkAction.fadeOut(0.3);
                if (idleAction) idleAction.reset().fadeIn(0.3).play();
            }
        },

        setTargetFps(fps) {
            if (Number.isFinite(fps) && fps > 0) targetFrameMs = 1000 / fps;
        },

        isLoaded: () => loaded,
        isVisible: () => visible,

        // Current eased altitude (meters) of the model's feet above the ground.
        // Used by the camera to frame the balloon itself rather than the ground
        // below it.
        getAltitude: () => altitude,

        // Meters from the model's feet to its vertical center.
        getModelCenterOffset: () => modelHalfHeight,

        // Full world-up height of the model in meters. The camera frames a
        // configurable fraction of this above the feet so it can lock onto the
        // bunny in the basket (low) rather than the balloon (middle/high).
        getModelHeight: () => modelHalfHeight * 2,

        // True while the altitude is still easing toward its target (lifting off
        // or touching down). The camera uses this to keep its smooth follow loop
        // running through the descent/ascent so the re-framing doesn't step at
        // the coarse tick rate.
        isAltitudeAnimating: () => Math.abs(altitude - (traveling ? flightAltitude : 0)) >= 1,

        destroy() {
            if (destroyed) return;
            destroyed = true;
            stopLoop();
            map.off("zoom", onZoom);
            map.off("resize", onResize);
            map.off("style.load", onStyleLoad);
            try { if (map.getLayer(PROBE_ID)) map.removeLayer(PROBE_ID); } catch (e) { }
            canvas.remove();
            renderer.dispose();
        }
    };
}
