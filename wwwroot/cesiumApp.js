/**
 * Minimal Cesium app: load Rocket.glb and move it using telemetry (ax/ay/az + yaw/pitch/roll).
 * This keeps the logic simple so you can add advanced math later.
 */
(() => {
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
  const viewer = new Cesium.Viewer("cesiumContainer", {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    shouldAnimate: true,
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
   * Drive the clock from telemetry samples to avoid drift.
   */
  viewer.clock.clockStep = Cesium.ClockStep.TICK_DEPENDENT;
  viewer.clock.multiplier = 1;
  viewer.clock.shouldAnimate = false;
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
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Motion state for basic integration when we do not have GPS position.
   */
  const POSITION_SCALE = 1;
  const MAX_SPEED_MPS = 500;
  const MAX_STEP_SECONDS = 1;
  const motionState = {
    lastT: null,
    t0: null,
    startTime: Cesium.JulianDate.now(),
    posENU: new Cesium.Cartesian3(0, 0, 0),
    velENU: new Cesium.Cartesian3(0, 0, 0),
    lastPosFixed: initialPos.clone(),
  };

  /**
   * Convert yaw/pitch to a forward unit vector in ENU.
   * @param {number} yawDeg
   * @param {number} pitchDeg
   * @returns {Cesium.Cartesian3}
   */
  function forwardFromYawPitch(yawDeg, pitchDeg) {
    const yaw = Cesium.Math.toRadians(yawDeg || 0);
    const pitch = Cesium.Math.toRadians(pitchDeg || 0);
    const cosP = Math.cos(pitch);
    return new Cesium.Cartesian3(
      Math.sin(yaw) * cosP, // east
      Math.cos(yaw) * cosP, // north
      Math.sin(pitch), // up
    );
  }

  /**
   * Check if lat/lon are plausible degrees.
   * @param {number | null} lat
   * @param {number | null} lon
   * @returns {boolean}
   */
  function isValidLatLon(lat, lon) {
    if (lat === null || lon === null) return false;
    return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
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
   * Parse CSV telemetry string into an object.
   * Format (server/Program.cs): t,seq,ax,ay,az,pitch,roll,yaw,temp,vel,press,lat,lon,alt,state
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
    };
  }

  /**
   * Move the rocket based on a telemetry sample.
   * Expected fields (numbers): t, ax, ay, az, pitch, roll, yaw, vel, lat, lon, alt.
   * If lat/lon look valid, we use GPS position directly.
   * Otherwise we integrate a velocity vector derived from yaw/pitch + vel (or accel).
   * @param {object} sample
   */
  function moveAlongCsvData(sample) {
    console.log("Processing sample:", sample);

    if (!sample || sample.type !== "telemetry") {
      console.warn("Sample rejected - wrong type or null");
      return;
    }

    const t = toNumber(sample.t);
    const ax = toNumber(sample.ax) ?? 0;
    const ay = toNumber(sample.ay) ?? 0;
    const az = toNumber(sample.az) ?? 0;
    const yaw = toNumber(sample.yaw) ?? 0;
    const pitch = toNumber(sample.pitch) ?? 0;
    const roll = toNumber(sample.roll) ?? 0;
    const vel = toNumber(sample.vel);
    const rawLat = toNumber(sample.lat);
    const rawLon = toNumber(sample.lon);
    const normalizedLatLon = normalizeLatLon(rawLat, rawLon);
    const lat = normalizedLatLon.lat;
    const lon = normalizedLatLon.lon;
    const alt = toNumber(sample.alt) ?? 0;

    console.log(
      `t=${t}, ax=${ax}, ay=${ay}, az=${az}, yaw=${yaw}, pitch=${pitch}, vel=${vel}`,
    );

    if (t === null) {
      console.warn("Invalid time value");
      return;
    }

    if (motionState.t0 === null) {
      motionState.t0 = t;
      motionState.startTime = Cesium.JulianDate.now();
      motionState.lastT = t;

      const firstPosFixed = isValidLatLon(lat, lon)
        ? Cesium.Cartesian3.fromDegrees(lon, lat, alt)
        : initialPos.clone();

      if (isValidLatLon(lat, lon)) {
        launchSite = { lon, lat, h: alt };
        originFixed = Cesium.Cartesian3.fromDegrees(
          launchSite.lon,
          launchSite.lat,
          launchSite.h,
        );
        enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(originFixed);
      }

      motionState.lastPosFixed = Cesium.Cartesian3.clone(firstPosFixed);
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
    if (isValidLatLon(lat, lon)) {
      // GPS position (best source).
      posFixed = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    } else {
      // Vector integration in ENU when no valid GPS.
      if (vel !== null) {
        const forward = forwardFromYawPitch(yaw, pitch);
        motionState.velENU = Cesium.Cartesian3.multiplyByScalar(
          forward,
          vel,
          motionState.velENU,
        );
      }

      const aENU = new Cesium.Cartesian3(ax, ay, az);
      if (vel === null) {
        const dv = Cesium.Cartesian3.multiplyByScalar(
          aENU,
          dtSafe,
          new Cesium.Cartesian3(),
        );
        motionState.velENU = Cesium.Cartesian3.add(
          motionState.velENU,
          dv,
          motionState.velENU,
        );
      }

      const deltaPos = new Cesium.Cartesian3();
      Cesium.Cartesian3.multiplyByScalar(motionState.velENU, dtSafe, deltaPos);
      if (vel === null) {
        Cesium.Cartesian3.add(
          deltaPos,
          Cesium.Cartesian3.multiplyByScalar(
            aENU,
            0.5 * dtSafe * dtSafe,
            new Cesium.Cartesian3(),
          ),
          deltaPos,
        );
      }
      motionState.posENU = Cesium.Cartesian3.add(
        motionState.posENU,
        deltaPos,
        motionState.posENU,
      );

      console.log(
        `Position ENU: x=${motionState.posENU.x.toFixed(2)}, y=${motionState.posENU.y.toFixed(2)}, z=${motionState.posENU.z.toFixed(2)}`,
      );

      // Convert to world coordinates and add to Cesium.
      posFixed = enuToEcef(
        motionState.posENU.x * POSITION_SCALE,
        motionState.posENU.y * POSITION_SCALE,
        motionState.posENU.z * POSITION_SCALE,
      );
    }

    if (motionState.lastPosFixed) {
      const maxStepMeters = MAX_SPEED_MPS * dtSafe;
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

    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(yaw),
      Cesium.Math.toRadians(pitch),
      Cesium.Math.toRadians(roll),
    );
    rocket.orientation = new Cesium.ConstantProperty(
      Cesium.Transforms.headingPitchRollQuaternion(posFixed, hpr),
    );

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

    viewer.clock.currentTime = currentTime.clone();
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
    if (payload?.type === "telemetry") {
      moveAlongCsvData(payload);
      return;
    }

    if (payload?.type === "raw" && typeof payload.raw === "string") {
      const parsed = parseTelemetry(payload.raw);
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

  connection.start().catch((err) => {
    console.error("SignalR start failed:", err);
  });
})();
