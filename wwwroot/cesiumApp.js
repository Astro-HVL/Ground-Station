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

      const microLat = lat / 1e6;
      const microLon = lon / 1e6;
      if (isValidLatLon(microLat, microLon)) {
        return { lat: microLat, lon: microLon };
      }

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
     * Parse CSV telemetry string into an object.
     * Format (server/Program.cs): t,seq,ax,ay,az,pitch,roll,yaw,temp,vel,press,lat,lon,alt,state[,east,north,up]
     * @param {string} csvLine - Raw CSV string from telemetry
     * @returns {object | null}
     */
    function parseTelemetry(csvLine) {
      if (typeof csvLine !== "string") return null;

      // Remove "RX: " prefix if present
      const cleaned = csvLine.replace(/^RX:\s*/, "").trim();
      const parts = cleaned.split(",");

      if (parts.length < 15) {
        console.warn("Invalid telemetry format:", csvLine);
        return null;
      }

      return {
        type: "telemetry",
        t: parseFloat(parts[0]), // time (seconds)
        seq: parseInt(parts[1]), // sequence id
        ax: parseFloat(parts[2]), // acceleration X
        ay: parseFloat(parts[3]), // acceleration Y
        az: parseFloat(parts[4]), // acceleration Z
        pitch: parseFloat(parts[5]), // pitch (degrees)
        roll: parseFloat(parts[6]), // roll (degrees)
        yaw: parseFloat(parts[7]), // yaw (degrees)
        temp: parseFloat(parts[8]), // temperature
        vel: parseFloat(parts[9]), // velocity (m/s)
        press: parseFloat(parts[10]), // pressure
        lat: parseFloat(parts[11]), // latitude (deg)
        lon: parseFloat(parts[12]), // longitude (deg)
        alt: parseFloat(parts[13]), // altitude (m)
        state: parseInt(parts[14]), // state
        east: parts.length > 15 ? parseFloat(parts[15]) : null, // east offset (m)
        north: parts.length > 16 ? parseFloat(parts[16]) : null, // north offset (m)
        up: parts.length > 17 ? parseFloat(parts[17]) : null, // up offset (m)
      };
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

      const hpr = new Cesium.HeadingPitchRoll(
        Cesium.Math.toRadians(yaw),
        Cesium.Math.toRadians(pitch),
        Cesium.Math.toRadians(roll),
      );
      rocket.orientation = new Cesium.ConstantProperty(
        Cesium.Transforms.headingPitchRollQuaternion(posFixed, hpr),
      );

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

    // Expose the function so you can call it from SignalR or the console.
    if (typeof window !== "undefined") {
      window.moveAlongCsvData = moveAlongCsvData;
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
        const parsed = parseTelemetry(payload.raw);
        if (parsed) moveAlongCsvData(parsed);
        return;
      }

      if (payload?.type === "json" && typeof payload.data === "string") {
        const parsed = parseTelemetry(payload.data);
        if (parsed) moveAlongCsvData(parsed);
        return;
      }

      if (typeof payload === "string") {
        const parsed = parseTelemetry(payload);
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
