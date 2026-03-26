/**
 * Minimal Cesium app: load Rocket.glb and move it using telemetry.
 * GPS is used when available; otherwise we stay in a launch-relative ENU frame.
 */
(() => {
  try {
    const DEBUG_TELEMETRY = false;

    function debugLog(...args) {
      if (DEBUG_TELEMETRY) {
        console.log(...args);
      }
    }

    /**
     * Cesium Ion access token (required for default world terrain).
     * @type {string}
     */
    const ION_TOKEN =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0ZDEzYmIxOS0yNDk0LTQ0NDItYjNlNy03NWU4Y2I4N2EzY2IiLCJpZCI6MzUyMDI0LCJpYXQiOjE3NjA5MDUyMTR9.aAyv_MXnZaN9y2QgSNRglNe5JyAMouG9lnoXJtJ-61E";
    Cesium.Ion.defaultAccessToken = ION_TOKEN;
    const serverBase =
      window.location.protocol === "file:" || window.location.origin === "null"
        ? "http://localhost:5242"
        : window.location.origin;

    /**
     * Launch site (degrees + meters). Used as the ENU origin.
     * @type {{lon: number, lat: number, h: number}}
     */
    let launchSite = {
      lon: 5.349723834309746,
      lat: 60.370157623938304,
      h: 100,
    };

    /**
     * Create the Cesium viewer and enable animation.
     * @type {Cesium.Viewer}
     */
    let worldTerrain;
    try {
      worldTerrain =
        Cesium.Terrain && typeof Cesium.Terrain.fromWorldTerrain === "function"
          ? Cesium.Terrain.fromWorldTerrain()
          : undefined;
    } catch (error) {
      console.warn(
        "World terrain unavailable, using ellipsoid terrain.",
        error,
      );
      worldTerrain = undefined;
    }

    const viewer = new Cesium.Viewer("cesiumContainer", {
      terrain: worldTerrain,
      shouldAnimate: true,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      vrButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      navigationHelpButton: false,
      sceneMode: Cesium.SceneMode.SCENE3D,
    });
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#102236");
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        launchSite.lon,
        launchSite.lat,
        launchSite.h + 2500,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-45),
        roll: 0.0,
      },
    });

    /**
     * Position samples for smooth motion.
     * @type {Cesium.SampledPositionProperty}
     */
    const position = new Cesium.SampledPositionProperty();
    position.setInterpolationOptions({
      interpolationAlgorithm: Cesium.LinearApproximation,
      interpolationDegree: 1,
    });
    position.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    position.forwardExtrapolationDuration = Number.POSITIVE_INFINITY;
    position.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    position.backwardExtrapolationDuration = Number.POSITIVE_INFINITY;
    const initialTime = Cesium.JulianDate.now();
    const initialTime2 = Cesium.JulianDate.addSeconds(
      initialTime,
      1,
      new Cesium.JulianDate(),
    );
    const initialPos = Cesium.Cartesian3.fromDegrees(
      launchSite.lon,
      launchSite.lat,
      launchSite.h,
    );
    position.addSample(initialTime, initialPos);
    position.addSample(initialTime2, initialPos);

    viewer.clock.startTime = initialTime.clone();
    viewer.clock.currentTime = initialTime.clone();
    viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
      initialTime,
      120,
      new Cesium.JulianDate(),
    );

    /**
     * Style for the flight path.
     * @type {Cesium.PathGraphics.ConstructorOptions}
     */
    const rocketPathStyle = {
      show: true,
      width: 6,
      leadTime: 0,
      trailTime: 300,
      resolution: 1,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.25,
        color: Cesium.Color.RED,
      }),
    };

    /**
     * Add the rocket entity.
     * @type {Cesium.Entity}
     */
    const rocket = viewer.entities.add({
      position,
      path: rocketPathStyle,
      model: {
        uri: `${serverBase}/models/Rocket.glb`,
        minimumPixelSize: 32,
        maximumScale: 500,
        silhouetteColor: Cesium.Color.WHITE,
        silhouetteSize: 1,
      },
    });
    // Side-follow camera offset (east, north, up in meters).
    rocket.viewFrom = new Cesium.Cartesian3(1800, 0, 500);
    viewer.trackedEntity = rocket;
    viewer.zoomTo(
      rocket,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(90),
        Cesium.Math.toRadians(-10),
        2500,
      ),
    );

    // Fallback trail polyline to keep history visible even if clock drifts.
    const trailPositions = [initialPos.clone()];
    const MAX_TRAIL_POINTS = 3000;
    viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => trailPositions, false),
        width: 4,
        material: Cesium.Color.ORANGE.withAlpha(0.9),
      },
    });
    /**
     * Let Cesium's clock run in real-time so SampledPositionProperty interpolates
     * smoothly between infrequent telemetry samples instead of jumping.
     */
    viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    viewer.clock.multiplier = 1;
    viewer.clock.shouldAnimate = true;
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;

    /**
     * ENU (east-north-up) transform for our local origin.
     */
    let originFixed = Cesium.Cartesian3.fromDegrees(
      launchSite.lon,
      launchSite.lat,
      launchSite.h,
    );
    let enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(originFixed);

    /**
     * Convert local ENU meters to ECEF (world) coordinates.
     * @param {number} e East meters
     * @param {number} n North meters
     * @param {number} u Up meters
     * @returns {Cesium.Cartesian3}
     */

    function enuToEcef(e, n, u) {
      const local = new Cesium.Cartesian3(e, n, u);
      return Cesium.Matrix4.multiplyByPoint(
        enuToFixed,
        local,
        new Cesium.Cartesian3(),
      );
    }

    /**
     * Parse a number safely.
     * @param {unknown} value
     * @returns {number | null}
     */
    function toNumber(value) {
      if (value === null || value === undefined || value === "") {
        return null;
      }
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    /**
     * Motion state for basic integration when we do not have GPS position.
     */
    const POSITION_SCALE = 20; // scale for tabel side testing
    const MAX_SPEED_MPS = 500;
    const MIN_DEAD_RECKON_VEL_MPS = 1.0; // Ignore velocity below this to suppress sensor noise when stationary
    // States <= this value are treated as "on the pad" — dead-reckoning velocity is
    // held at zero so sensor bias does not drift the rocket before launch.
    // Adjust to match your firmware's state numbering (0 = idle, 1 = armed, etc.).
    const GROUND_MAX_STATE = 1;
    const MAX_STEP_SECONDS = 1;
    const FALLBACK_SAMPLE_INTERVAL_SECONDS = 0.05;
    const MIN_SAMPLE_INTERVAL_SECONDS = 0.2;
    const MIN_SAMPLE_DISTANCE_METERS = 0.5;
    const ALTITUDE_DEADBAND_METERS = 0.05;
    const VECTOR_DEADBAND_METERS = 0.25;
    const motionState = {
      lastT: null,
      t0: null,
      startTime: Cesium.JulianDate.now(),
      alt0: null,
      posENU: new Cesium.Cartesian3(0, 0, 0),
      velENU: new Cesium.Cartesian3(0, 0, 0),
      // Gravity vector in body frame, calibrated while on the pad.
      // Initial guess: body Y = up (matches sample data ay ≈ 1g at rest).
      gravityBody: new Cesium.Cartesian3(0, 9.81, 0),
      lastPosFixed: initialPos.clone(),
      lastRenderedT: null,
      lastRenderedPosFixed: initialPos.clone(),
      lastInputTimeRaw: null,
      timeScale: null,
      wallClockT0: null,
    };

    /**
     * Check if lat/lon are plausible degree values.
     * @param {number | null} lat
     * @param {number | null} lon
     * @returns {boolean}
     */
    function isValidLatLon(lat, lon) {
      if (lat === null || lon === null) return false;
      return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    /**
     * Reject common "no GPS fix" placeholders like 0,0.
     * @param {number | null} lat
     * @param {number | null} lon
     * @returns {boolean}
     */
    function hasUsableGpsFix(lat, lon) {
      if (!isValidLatLon(lat, lon)) return false;
      return Math.abs(lat) > 1e-6 || Math.abs(lon) > 1e-6;
    }

    /**
     * Convert GPS values to degrees if the payload uses microdegrees.
     * @param {number | null} lat
     * @param {number | null} lon
     * @returns {{lat: number | null, lon: number | null}}
     */
    function normalizeLatLon(lat, lon) {
      if (lat === null || lon === null) return { lat: null, lon: null };
      if (isValidLatLon(lat, lon)) return { lat, lon };
      // Reject scaled integers — real GPS must send proper decimal degrees.
      return { lat: null, lon: null };
    }

    /**
     * Return the first finite numeric value found under any of the provided keys.
     * @param {object} sample
     * @param {string[]} keys
     * @returns {number | null}
     */
    function readOptionalNumber(sample, keys) {
      for (const key of keys) {
        const value = toNumber(sample?.[key]);
        if (value !== null) return value;
      }
      return null;
    }

    /**
     * Read optional ENU offsets from the payload.
     * Supported keys include absolute east/north/up and delta dE/dN/dU values.
     * @param {object} sample
     * @returns {{
     *   east: number | null,
     *   north: number | null,
     *   up: number | null,
     *   deltaEast: number | null,
     *   deltaNorth: number | null,
     *   deltaUp: number | null
     * }}
     */
    function readRelativeEnu(sample) {
      return {
        east: readOptionalNumber(sample, [
          "east",
          "x",
          "e",
          "enuEast",
          "posE",
          "positionEast",
        ]),
        north: readOptionalNumber(sample, [
          "north",
          "y",
          "n",
          "enuNorth",
          "posN",
          "positionNorth",
        ]),
        up: readOptionalNumber(sample, [
          "up",
          "z",
          "u",
          "enuUp",
          "posU",
          "positionUp",
        ]),
        deltaEast: readOptionalNumber(sample, [
          "dE",
          "deltaEast",
          "deltaE",
          "eastDelta",
          "dx",
        ]),
        deltaNorth: readOptionalNumber(sample, [
          "dN",
          "deltaNorth",
          "deltaN",
          "northDelta",
          "dy",
        ]),
        deltaUp: readOptionalNumber(sample, [
          "dU",
          "deltaUp",
          "deltaU",
          "upDelta",
          "dz",
        ]),
      };
    }

    /**
     * Infer an obvious time scale from a large absolute timestamp.
     * @param {number} rawTime
     * @returns {number | null}
     */
    function inferTimeScaleFromMagnitude(rawTime) {
      const absTime = Math.abs(rawTime);
      if (absTime >= 1e17) return 1e9;
      if (absTime >= 1e14) return 1e6;
      if (absTime >= 1e11) return 1e3;
      return null;
    }

    /**
     * Infer the unit scale from a raw timestamp delta.
     * Assumes telemetry sample spacing is not tens of seconds apart.
     * @param {number} deltaRaw
     * @returns {number}
     */
    function inferTimeScaleFromDelta(deltaRaw) {
      const absDelta = Math.abs(deltaRaw);
      if (!Number.isFinite(absDelta) || absDelta === 0) return 1;
      if (absDelta <= 60) return 1;
      if (absDelta <= 60_000) return 1e3;
      if (absDelta <= 60_000_000) return 1e6;
      return 1e9;
    }

    /**
     * Resolve the sample time from telemetry or, if missing, from wall-clock time.
     * @param {object} sample
     * @returns {number}
     */
    function resolveSampleTime(sample) {
      const rawTime = readOptionalNumber(sample, [
        "t",
        "time",
        "timestamp",
        "ts",
        "elapsed",
      ]);
      if (rawTime !== null) {
        if (motionState.lastInputTimeRaw === null) {
          motionState.lastInputTimeRaw = rawTime;
          motionState.timeScale = inferTimeScaleFromMagnitude(rawTime);
          return 0;
        }

        const deltaRaw = rawTime - motionState.lastInputTimeRaw;
        const timeScale =
          motionState.timeScale ?? inferTimeScaleFromDelta(deltaRaw);
        motionState.lastInputTimeRaw = rawTime;
        motionState.timeScale = timeScale;
        return (motionState.lastT ?? 0) + deltaRaw / timeScale;
      }

      const nowSeconds =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now() / 1000
          : Date.now() / 1000;

      if (motionState.wallClockT0 === null) {
        motionState.wallClockT0 = nowSeconds;
        return 0;
      }

      const elapsed = nowSeconds - motionState.wallClockT0;
      if (elapsed > 0) {
        return elapsed;
      }

      return (motionState.lastT ?? 0) + FALLBACK_SAMPLE_INTERVAL_SECONDS;
    }

    /**
     * Remove tiny sensor noise around zero.
     * @param {number} value
     * @param {number} threshold
     * @returns {number}
     */
    function applyDeadband(value, threshold) {
      return Math.abs(value) < threshold ? 0 : value;
    }

    /**
     * Check whether this sample should be pushed into Cesium.
     * @param {number} t
     * @param {Cesium.Cartesian3} posFixed
     * @returns {boolean}
     */
    function shouldRenderSample(t, posFixed) {
      if (motionState.lastRenderedT === null) return true;
      if (t - motionState.lastRenderedT >= MIN_SAMPLE_INTERVAL_SECONDS) {
        return true;
      }
      return (
        Cesium.Cartesian3.distance(
          motionState.lastRenderedPosFixed,
          posFixed,
        ) >= MIN_SAMPLE_DISTANCE_METERS
      );
    }

    /**
     * Check whether an object looks like telemetry even if it lacks a type wrapper.
     * @param {unknown} payload
     * @returns {boolean}
     */
    function isTelemetryLikePayload(payload) {
      if (!payload || typeof payload !== "object") return false;
      const sample = /** @type {Record<string, unknown>} */ (payload);
      return [
        "t",
        "time",
        "timestamp",
        "ax",
        "ay",
        "az",
        "pitch",
        "roll",
        "yaw",
        "lat",
        "latitude",
        "lon",
        "lng",
        "longitude",
        "alt",
        "altitude",
        "east",
        "north",
        "up",
        "x",
        "y",
        "z",
        "dE",
        "dN",
        "dU",
      ].some((key) => sample[key] !== undefined);
    }

    /**
     * Normalize event payloads from different telemetry publishers.
     * @param {unknown} payload
     * @returns {object | null}
     */
    function normalizeTelemetryPayload(payload) {
      if (!payload || typeof payload !== "object") {
        return null;
      }

      if (payload.type === "telemetry") {
        return payload;
      }

      if (payload.type === "json" && isTelemetryLikePayload(payload.data)) {
        return {
          type: "telemetry",
          ...payload.data,
        };
      }

      if (isTelemetryLikePayload(payload.data)) {
        return {
          type: "telemetry",
          ...payload.data,
        };
      }

      if (isTelemetryLikePayload(payload)) {
        return {
          type: "telemetry",
          ...payload,
        };
      }

      return null;
    }

    /**
     * When true, field 0 of the rocket payload ('press') is treated as barometric
     * altitude in metres ASL.  Sample value 124.7 m sits ~25 m above the hard-coded
     * launch site (h = 100 m), which is consistent with bench / pad testing.
     *
     * Set to false if the sensor really reports atmospheric pressure (hPa / kPa);
     * in that case altitude falls back to acceleration-based dead-reckoning.
     *
     * NOTE: POSITION_SCALE (currently 20) is applied to every ENU component in the
     * dead-reckoning path.  For real flights set POSITION_SCALE = 1; the scale-up
     * is only useful when movements are sub-metre during table-top tests.
     */
    const USE_PRESS_AS_ALTITUDE = true;

    /**
     * Parse a raw TX or RX telemetry line into a normalised state object.
     *
     * Observed wire formats
     * ─────────────────────
     * TX (9 fields):
     *   press, temp, ax, ay, az, qx, qy, qz, state
     *   e.g. "TX: 124.7,24.61,0.15,1.01,0,0,-1,0,3"
     *
     * RX (16 fields):
     *   rssi, seq, f2, f3, f4, f5, f6, <TX payload × 9>
     *   e.g. "RX: 91.0,8519,0.07,-0.09,1.0,-0.1,-0.1,124.7,24.61,0.16,1.01,0,0,-1,0,3"
     *   Fields 0–6 are radio-link metadata; fields 7–15 are the TX payload.
     *
     * Orientation is a compact unit quaternion: qx, qy, qz are the vector part;
     * qw = sqrt(1 − qx² − qy² − qz²) is derived at parse time.
     *
     * AMBIGUITY – field 0 ('press'):
     *   124.7 does NOT look like atmospheric pressure in hPa (sea-level ≈ 1013)
     *   or kPa (sea-level ≈ 101).  It is within range for metres ASL near a 100 m
     *   launch site, so USE_PRESS_AS_ALTITUDE = true is the default.  If your
     *   sensor outputs pressure instead, flip that flag and supply altitude via a
     *   separate channel (or rely on dead-reckoning from acceleration).
     *
     * @param {string} line
     * @returns {{ type:"telemetry", rssi:number|null, seq:number|null,
     *             press:number, temp:number, ax:number, ay:number, az:number,
     *             qx:number, qy:number, qz:number, state:number,
     *             alt:number|null } | null}
     */
    function parseTelemetryLine(line) {
      if (typeof line !== "string") return null;
      const isRX = /^RX:\s*/i.test(line);
      const cleaned = line.replace(/^[RT]X:\s*/i, "").trim();
      const parts = cleaned.split(",");

      let rssi = null;
      let seq  = null;
      let payload;

      if (isRX) {
        if (parts.length < 16) {
          console.warn("[parseTelemetryLine] RX needs ≥16 fields, got", parts.length, "—", line);
          return null;
        }
        rssi    = toNumber(parts[0]);
        seq     = toNumber(parts[1]);
        // Fields 7–15 are the 9-field rocket state payload (identical to TX).
        payload = parts.slice(7, 16);
      } else {
        // TX or bare CSV — expect exactly 9 rocket-state fields.
        if (parts.length < 9) {
          console.warn("[parseTelemetryLine] TX needs ≥9 fields, got", parts.length, "—", line);
          return null;
        }
        payload = parts.slice(0, 9);
      }

      const nums = payload.map(toNumber);
      if (nums.some((v) => v === null)) {
        console.warn("[parseTelemetryLine] Non-numeric payload field:", payload);
        return null;
      }

      const [press, temp, ax, ay, az, qx, qy, qz, state] = nums;

      // Expose 'alt' so the existing altitude-handling path in moveAlongCsvData
      // picks it up automatically via readOptionalNumber(sample, ["alt", ...]).
      const alt = USE_PRESS_AS_ALTITUDE ? press : null;

      return { type: "telemetry", rssi, seq, press, temp, ax, ay, az, qx, qy, qz, state, alt };
    }

    /**
     * Normalise a Cesium.Quaternion in-place.
     * If the magnitude is near zero the quaternion is replaced with the identity.
     * @param {Cesium.Quaternion} q - Modified in-place.
     * @returns {Cesium.Quaternion}
     */
    function normalizeQuaternion(q) {
      const mag2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
      if (mag2 < 1e-12) {
        q.x = 0; q.y = 0; q.z = 0; q.w = 1;
        return q;
      }
      return Cesium.Quaternion.normalize(q, q);
    }

    /**
     * Convert the IMU's compact quaternion into a Cesium world-frame (ECEF) quaternion.
     *
     * The telemetry encodes only three quaternion components (qx, qy, qz); qw is
     * recovered from the unit-quaternion constraint.  The body-frame rotation is
     * then composed with the ENU→ECEF rotation at the launch origin so the rocket
     * is oriented correctly in the world.
     *
     * Composition: q_world = q_enuToEcef × q_imuBody
     *
     * @param {object}          sample       – telemetry sample with qx/qy/qz fields
     * @param {Cesium.Matrix4}  enuTransform – eastNorthUpToFixedFrame at the ENU origin
     * @returns {Cesium.Quaternion | null}
     */
    function buildOrientationFromImu(sample, enuTransform) {
      const qx = toNumber(sample?.qx);
      const qy = toNumber(sample?.qy);
      const qz = toNumber(sample?.qz);
      if (qx === null || qy === null || qz === null) return null;

      const mag2 = qx * qx + qy * qy + qz * qz;
      if (mag2 > 1.0 + 1e-4) {
        // Vector part exceeds the unit sphere — quaternion is invalid; skip.
        console.warn("[buildOrientationFromImu] |qvec|² > 1:", qx, qy, qz);
        return null;
      }

      // Positive root gives rotation angle ∈ [0°, 180°], the conventional range.
      const qw = Math.sqrt(Math.max(0, 1 - mag2));

      // Normalise to guard against floating-point drift.
      const qImu = normalizeQuaternion(new Cesium.Quaternion(qx, qy, qz, qw));

      // Extract the rotation part of the ENU→ECEF 4×4 transform.
      const enuMat3 = Cesium.Matrix4.getMatrix3(enuTransform, new Cesium.Matrix3());
      const qEnu   = Cesium.Quaternion.fromRotationMatrix(enuMat3, new Cesium.Quaternion());

      // Compose: world orientation = ENU_rotation × IMU_body_rotation.
      return Cesium.Quaternion.multiply(qEnu, qImu, new Cesium.Quaternion());
    }

    /**
     * Move the rocket based on a telemetry sample.
     * Expected fields (numbers): t, ax, ay, az, pitch, roll, yaw, vel, lat, lon, alt.
     * If GPS is missing we keep the rocket in a launch-relative ENU frame.
     * @param {object} sample
     */
    function moveAlongCsvData(sample) {
      debugLog("Processing sample:", sample);

      if (!sample || sample.type !== "telemetry") {
        console.warn("Sample rejected - wrong type or null");
        return;
      }

      const t = resolveSampleTime(sample);
      const ax = readOptionalNumber(sample, ["ax", "accX", "accelX"]) ?? 0;
      const ay = readOptionalNumber(sample, ["ay", "accY", "accelY"]) ?? 0;
      const az = readOptionalNumber(sample, ["az", "accZ", "accelZ"]) ?? 0;
      const yaw =
        readOptionalNumber(sample, ["yaw", "heading", "psi", "headingDeg"]) ??
        0;
      const pitch =
        readOptionalNumber(sample, ["pitch", "theta", "pitchDeg"]) ?? 0;
      const roll = readOptionalNumber(sample, ["roll", "phi", "rollDeg"]) ?? 0;
      const vel = readOptionalNumber(sample, [
        "vel",
        "velocity",
        "speed",
        "verticalSpeed",
        "vz",
      ]);
      const state = readOptionalNumber(sample, [
        "state",
        "flightState",
        "mode",
      ]);
      const rawLat = readOptionalNumber(sample, ["lat", "latitude"]);
      const rawLon = readOptionalNumber(sample, ["lon", "lng", "longitude"]);
      const rawAlt = readOptionalNumber(sample, [
        "alt",
        "altitude",
        "height",
        "h",
      ]);
      const normalizedLatLon = normalizeLatLon(rawLat, rawLon);
      const lat = normalizedLatLon.lat;
      const lon = normalizedLatLon.lon;
      const alt = rawAlt ?? 0;
      const relativeEnu = readRelativeEnu(sample);
      const hasRelativeUp = relativeEnu.up !== null;
      const hasGpsFix = hasUsableGpsFix(lat, lon);

      debugLog(
        `t=${t}, ax=${ax}, ay=${ay}, az=${az}, yaw=${yaw}, pitch=${pitch}, vel=${vel}, state=${state}`,
      );

      if (motionState.t0 === null) {
        motionState.t0 = t;
        motionState.startTime = Cesium.JulianDate.now();
        motionState.lastT = t;
        motionState.alt0 = rawAlt;

        const firstPosFixed = hasGpsFix
          ? Cesium.Cartesian3.fromDegrees(lon, lat, alt)
          : initialPos.clone();

        if (hasGpsFix) {
          launchSite = { lon, lat, h: alt };
          originFixed = Cesium.Cartesian3.fromDegrees(
            launchSite.lon,
            launchSite.lat,
            launchSite.h,
          );
          enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(originFixed);
        }

        motionState.lastPosFixed = Cesium.Cartesian3.clone(firstPosFixed);
        motionState.lastRenderedT = t;
        motionState.lastRenderedPosFixed =
          Cesium.Cartesian3.clone(firstPosFixed);
        position.addSample(motionState.startTime, firstPosFixed);
        trailPositions.length = 0;
        trailPositions.push(Cesium.Cartesian3.clone(firstPosFixed));
        viewer.clock.startTime = motionState.startTime.clone();
        viewer.clock.currentTime = motionState.startTime.clone();
        viewer.clock.stopTime = Cesium.JulianDate.addSeconds(
          motionState.startTime,
          120,
          new Cesium.JulianDate(),
        );
        return;
      }

      const dt = motionState.lastT === null ? 0 : t - motionState.lastT;
      motionState.lastT = t;
      if (dt <= 0) return;
      const dtSafe = Math.min(dt, MAX_STEP_SECONDS);

      let posFixed = null;
      if (hasGpsFix) {
        // GPS position (best source).
        posFixed = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      } else {
        // No GPS fix: use explicit ENU offsets if present, otherwise keep a stable
        // launch-relative track and use altitude as the vertical component.
        const pitchRad = Cesium.Math.toRadians(pitch);
        const yawRad = Cesium.Math.toRadians(yaw);

        // Hold dead-reckoning velocity at zero while the rocket is on the pad and
        // continuously calibrate the body-frame gravity vector from the accelerometer.
        // This ensures gravity is correctly subtracted regardless of IMU axis convention.
        if (state !== null && state <= GROUND_MAX_STATE) {
          motionState.velENU.x = 0;
          motionState.velENU.y = 0;
          motionState.velENU.z = 0;
          motionState.gravityBody.x = ax * 9.81;
          motionState.gravityBody.y = ay * 9.81;
          motionState.gravityBody.z = az * 9.81;
        }

        // Acceleration-based dead-reckoning.
        // Rotate body-frame IMU acceleration (ax/ay/az, in g) into ENU frame using
        // the IMU quaternion, subtract gravity, then integrate → velocity → position.
        // This is the primary source of horizontal (east/north) movement when there
        // is no GPS, no explicit ENU data, and no vel field in the telemetry.
        let accelENU = null;
        {
          const qxS = toNumber(sample?.qx);
          const qyS = toNumber(sample?.qy);
          const qzS = toNumber(sample?.qz);
          if (qxS !== null && qyS !== null && qzS !== null) {
            const mag2 = qxS * qxS + qyS * qyS + qzS * qzS;
            if (mag2 <= 1.0 + 1e-4) {
              const qwS = Math.sqrt(Math.max(0, 1 - mag2));
              const qImu = normalizeQuaternion(
                new Cesium.Quaternion(qxS, qyS, qzS, qwS),
              );
              // ax/ay/az are in g; convert to m/s².
              // Subtract the calibrated body-frame gravity BEFORE rotating so that
              // the correct gravity axis is removed regardless of IMU mounting convention.
              const G = 9.81;
              const accelBody = new Cesium.Cartesian3(
                ax * G - motionState.gravityBody.x,
                ay * G - motionState.gravityBody.y,
                az * G - motionState.gravityBody.z,
              );
              const rotMat = Cesium.Matrix3.fromQuaternion(
                qImu,
                new Cesium.Matrix3(),
              );
              accelENU = Cesium.Matrix3.multiplyByVector(
                rotMat,
                accelBody,
                new Cesium.Cartesian3(),
              );

              // Integrate velocity (v += a·dt).
              motionState.velENU.x += accelENU.x * dtSafe;
              motionState.velENU.y += accelENU.y * dtSafe;
              motionState.velENU.z += accelENU.z * dtSafe;
            }
          }
        }

        if (relativeEnu.deltaEast !== null) {
          motionState.posENU.x += relativeEnu.deltaEast;
        } else if (relativeEnu.east !== null) {
          motionState.posENU.x = applyDeadband(
            relativeEnu.east,
            VECTOR_DEADBAND_METERS,
          );
        } else if (vel !== null && Math.abs(vel) >= MIN_DEAD_RECKON_VEL_MPS) {
          // Dead-reckoning: project velocity onto east axis using pitch + yaw.
          // Assumes pitch=0 pointing straight up (rocket convention), 90=horizontal.
          // Assumes yaw=0 north, increasing clockwise (compass heading).
          motionState.posENU.x +=
            vel * Math.sin(pitchRad) * Math.sin(yawRad) * dtSafe;
        } else if (accelENU !== null) {
          // Integrate position from IMU-derived velocity (p += v·dt).
          motionState.posENU.x += motionState.velENU.x * dtSafe;
        }

        if (relativeEnu.deltaNorth !== null) {
          motionState.posENU.y += relativeEnu.deltaNorth;
        } else if (relativeEnu.north !== null) {
          motionState.posENU.y = applyDeadband(
            relativeEnu.north,
            VECTOR_DEADBAND_METERS,
          );
        } else if (vel !== null && Math.abs(vel) >= MIN_DEAD_RECKON_VEL_MPS) {
          motionState.posENU.y +=
            vel * Math.sin(pitchRad) * Math.cos(yawRad) * dtSafe;
        } else if (accelENU !== null) {
          motionState.posENU.y += motionState.velENU.y * dtSafe;
        }

        if (relativeEnu.deltaUp !== null) {
          motionState.posENU.z += relativeEnu.deltaUp;
        } else if (hasRelativeUp) {
          motionState.posENU.z = applyDeadband(
            relativeEnu.up,
            ALTITUDE_DEADBAND_METERS,
          );
        } else if (rawAlt !== null) {
          if (motionState.alt0 === null) {
            motionState.alt0 = rawAlt;
          }
          motionState.posENU.z = applyDeadband(
            rawAlt - motionState.alt0,
            ALTITUDE_DEADBAND_METERS,
          );
        } else if (vel !== null && Math.abs(vel) >= MIN_DEAD_RECKON_VEL_MPS) {
          motionState.posENU.z += vel * Math.cos(pitchRad) * dtSafe;
        } else if (accelENU !== null) {
          motionState.posENU.z += motionState.velENU.z * dtSafe;
        }

        debugLog(
          `Position ENU: x=${motionState.posENU.x.toFixed(2)}, y=${motionState.posENU.y.toFixed(2)}, z=${motionState.posENU.z.toFixed(2)}`,
        );

        // Convert launch-relative ENU to world coordinates.
        posFixed = enuToEcef(
          motionState.posENU.x * POSITION_SCALE,
          motionState.posENU.y * POSITION_SCALE,
          motionState.posENU.z * POSITION_SCALE,
        );
      }

      if (motionState.lastPosFixed) {
        const maxStepMeters =
          MAX_SPEED_MPS * (hasGpsFix ? 1 : POSITION_SCALE) * dtSafe;
        const rawStepMeters = Cesium.Cartesian3.distance(
          motionState.lastPosFixed,
          posFixed,
        );

        if (rawStepMeters > maxStepMeters && maxStepMeters > 0) {
          const dir = Cesium.Cartesian3.subtract(
            posFixed,
            motionState.lastPosFixed,
            new Cesium.Cartesian3(),
          );
          Cesium.Cartesian3.normalize(dir, dir);
          posFixed = Cesium.Cartesian3.add(
            motionState.lastPosFixed,
            Cesium.Cartesian3.multiplyByScalar(
              dir,
              maxStepMeters,
              new Cesium.Cartesian3(),
            ),
            new Cesium.Cartesian3(),
          );
        }
      }
      motionState.lastPosFixed = Cesium.Cartesian3.clone(posFixed);

      // Prefer IMU quaternion (qx/qy/qz from telemetry); fall back to Euler HPR.
      const imuQuat = buildOrientationFromImu(sample, enuToFixed);
      if (imuQuat) {
        rocket.orientation = new Cesium.ConstantProperty(imuQuat);
      } else {
        const hpr = new Cesium.HeadingPitchRoll(
          Cesium.Math.toRadians(yaw),
          Cesium.Math.toRadians(pitch),
          Cesium.Math.toRadians(roll),
        );
        rocket.orientation = new Cesium.ConstantProperty(
          Cesium.Transforms.headingPitchRollQuaternion(posFixed, hpr),
        );
      }

      if (!shouldRenderSample(t, posFixed)) {
        if (viewer.trackedEntity !== rocket) {
          viewer.trackedEntity = rocket;
        }
        return;
      }

      const currentTime = Cesium.JulianDate.addSeconds(
        motionState.startTime,
        t - motionState.t0,
        new Cesium.JulianDate(),
      );

      position.addSample(currentTime, posFixed);
      trailPositions.push(Cesium.Cartesian3.clone(posFixed));
      if (trailPositions.length > MAX_TRAIL_POINTS) {
        trailPositions.shift();
      }
      motionState.lastRenderedT = t;
      motionState.lastRenderedPosFixed = Cesium.Cartesian3.clone(posFixed);

      const newStop = Cesium.JulianDate.addSeconds(
        currentTime,
        120,
        new Cesium.JulianDate(),
      );
      if (
        !viewer.clock.stopTime ||
        Cesium.JulianDate.greaterThan(newStop, viewer.clock.stopTime)
      ) {
        viewer.clock.stopTime = newStop;
      }

      if (viewer.trackedEntity !== rocket) {
        viewer.trackedEntity = rocket;
      }
    }

    // Expose functions for SignalR consumers and console testing.
    if (typeof window !== "undefined") {
      window.moveAlongCsvData  = moveAlongCsvData;
      window.parseTelemetryLine = parseTelemetryLine; // e.g. parseTelemetryLine("TX: 124.7,24.61,0.15,1.01,0,0,-1,0,3")
    }

    const connection = new signalR.HubConnectionBuilder()
      .withUrl(`${serverBase}/telemetry`)
      .withAutomaticReconnect()
      .build();

    connection.on("telemetry", (payload) => {
      const normalizedPayload = normalizeTelemetryPayload(payload);
      if (normalizedPayload) {
        moveAlongCsvData(normalizedPayload);
        return;
      }

      if (payload?.type === "raw" && typeof payload.raw === "string") {
        const parsed = parseTelemetryLine(payload.raw);
        if (parsed) moveAlongCsvData(parsed);
        return;
      }

      if (payload?.type === "json" && typeof payload.data === "string") {
        const parsed = parseTelemetryLine(payload.data);
        if (parsed) moveAlongCsvData(parsed);
        return;
      }

      if (typeof payload === "string") {
        const parsed = parseTelemetryLine(payload);
        if (parsed) moveAlongCsvData(parsed);
        return;
      }

      console.warn("Unhandled telemetry payload:", payload);
    });

    async function startConnection() {
      try {
        await connection.start();
      } catch (err) {
        console.error("SignalR start failed:", err);
        setTimeout(startConnection, 2000);
      }
    }

    startConnection();
  } catch (err) {
    console.error("Cesium bootstrap failed:", err);
    const el = document.getElementById("cesiumContainer");
    if (el) {
      el.innerHTML =
        '<div style="color:#fff;padding:12px;font:14px Segoe UI,sans-serif;">Cesium failed to load. Check console for details.</div>';
    }
  }
})();
