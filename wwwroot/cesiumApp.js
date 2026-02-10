const conn = (typeof signalR !== 'undefined' && signalR?.HubConnectionBuilder)
  ? new signalR.HubConnectionBuilder().withUrl('/telemetry').withAutomaticReconnect().build()
  : null;

(async () => {
  const { INSState, CFParams, Vec3, ins_update, euler_from_q } =
    await import('./worker.js');

// ---- Telemetry ingestion state ----
const telemetryQueue = [];
const directFixQueue = [];
let csvHeader = null;
let csvRemainder = '';
let lastParseWarning = 0;
let forceReinitOnNextSample = true;
let useDirectTelemetry = false;

// ---- INS core state (declared early so telemetry handlers can access safely) ----
const st = new INSState();
const cf = new CFParams(0.02, 0.02, 0.05);
const dtINS = 0.01; // 100 Hz INS update step
const g0 = 9.80665;
let P0 = 101325.0; // Pa (reference pressure)
let gyro = new Vec3(0,0,0);              // rad/s
let acc  = new Vec3(0,0,-g0);            // m/s^2 (specific force)
let mag  = new Vec3(0.2, 0.0, -0.45);    // calibrated, arbitrary units
let P = P0;                              // Pa (baro)
let decl = 0.0;                          // magnetic declination (rad)

function normalizeHeaderName(name = '') {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizedAliases(list) {
  return list.map(normalizeHeaderName);
}

const aliasMap = {
  timestamp: normalizedAliases(['timestamp', 'time', 'utc', 't', 'epoch', 'epochns', 'epochms']),
  gyroX: normalizedAliases(['gyro_x', 'gyrox', 'gx', 'p', 'wx', 'omegax']),
  gyroY: normalizedAliases(['gyro_y', 'gyroy', 'gy', 'q', 'wy', 'omegay']),
  gyroZ: normalizedAliases(['gyro_z', 'gyroz', 'gz', 'r', 'wz', 'omegaz']),
  accX: normalizedAliases(['acc_x', 'accel_x', 'ax', 'accx', 'fx', 'forcex']),
  accY: normalizedAliases(['acc_y', 'accel_y', 'ay', 'accy', 'fy', 'forcey']),
  accZ: normalizedAliases(['acc_z', 'accel_z', 'az', 'accz', 'fz', 'forcez']),
  magX: normalizedAliases(['mag_x', 'magnet_x', 'mx', 'magx']),
  magY: normalizedAliases(['mag_y', 'magnet_y', 'my', 'magy']),
  magZ: normalizedAliases(['mag_z', 'magnet_z', 'mz', 'magz']),
  pressure: normalizedAliases(['pressure', 'baro', 'barometer', 'p', 'press']),
  referencePressure: normalizedAliases(['p0', 'pref', 'pressure0', 'refpressure', 'pzero', 'pressure_ref']),
  declination: normalizedAliases(['declination', 'magdecl', 'decl', 'magneticdeclination']),
};

const defaultOrder = {
  timestamp: 0,
  gyroX: 1,
  gyroY: 2,
  gyroZ: 3,
  accX: 4,
  accY: 5,
  accZ: 6,
  magX: 7,
  magY: 8,
  magZ: 9,
  pressure: 10,
  referencePressure: 11,
  declination: 12,
};

function parseMaybeNumber(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function resolveColumn(key, parts) {
  let index = -1;
  if (csvHeader) {
    const aliases = aliasMap[key] ?? [];
    index = csvHeader.findIndex((header) => aliases.includes(header));
  }
  if (index === -1 && defaultOrder[key] !== undefined) {
    index = defaultOrder[key];
  }
  if (index < 0 || index >= parts.length) return null;
  return parts[index];
}

function parseTimestamp(raw) {
  if (!raw && raw !== 0) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const numericValue = Number(trimmed);
  if (Number.isFinite(numericValue)) {
    // Assume milliseconds if value looks like Unix epoch (>= 1e12), seconds otherwise
    const millis = numericValue > 1e11 ? numericValue : numericValue * 1000;
    const dateFromNumber = new Date(millis);
    return Number.isNaN(dateFromNumber.valueOf()) ? null : dateFromNumber;
  }
  const dateFromString = new Date(trimmed);
  return Number.isNaN(dateFromString.valueOf()) ? null : dateFromString;
}

function toRadiansIfNeeded(value) {
  if (value === null || value === undefined) return null;
  const absVal = Math.abs(value);
  if (!Number.isFinite(absVal)) return null;
  return absVal > Math.PI ? (value * Math.PI) / 180.0 : value;
}

function buildTelemetrySample(parts) {
  const gyroX = parseMaybeNumber(resolveColumn('gyroX', parts));
  const gyroY = parseMaybeNumber(resolveColumn('gyroY', parts));
  const gyroZ = parseMaybeNumber(resolveColumn('gyroZ', parts));
  const accX = parseMaybeNumber(resolveColumn('accX', parts));
  const accY = parseMaybeNumber(resolveColumn('accY', parts));
  const accZ = parseMaybeNumber(resolveColumn('accZ', parts));
  const magX = parseMaybeNumber(resolveColumn('magX', parts));
  const magY = parseMaybeNumber(resolveColumn('magY', parts));
  const magZ = parseMaybeNumber(resolveColumn('magZ', parts));
  const pressure = parseMaybeNumber(resolveColumn('pressure', parts));
  const referencePressure = parseMaybeNumber(resolveColumn('referencePressure', parts));
  const declination = parseMaybeNumber(resolveColumn('declination', parts));
  const timestampRaw = resolveColumn('timestamp', parts);

  if ([gyroX, gyroY, gyroZ, accX, accY, accZ].some((v) => v === null)) {
    return null;
  }

  const sample = {
    timestamp: parseTimestamp(timestampRaw),
    gyro: new Vec3(gyroX, gyroY, gyroZ),
    acc: new Vec3(accX, accY, accZ),
    mag: (magX !== null && magY !== null && magZ !== null)
      ? new Vec3(magX, magY, magZ)
      : null,
    pressure,
    referencePressure,
    declinationRad: toRadiansIfNeeded(declination),
  };
  return sample;
}

function parseTelemetryCsvLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(',').map((part) => part.trim());

  // Detect header when no numeric content exists
  const hasNumeric = parts.some((part) => parseMaybeNumber(part) !== null);
  if (!csvHeader && !hasNumeric) {
    csvHeader = parts.map(normalizeHeaderName);
    return null;
  }

  const sample = buildTelemetrySample(parts);
  if (!sample && Date.now() - lastParseWarning > 5000) {
    console.warn('Skipping CSV telemetry line due to missing required fields:', trimmed);
    lastParseWarning = Date.now();
  }
  return sample;
}

function ingestTelemetryCsvPayload(payload) {
  if (typeof payload !== 'string') {
    if (Date.now() - lastParseWarning > 5000) {
      console.warn('Telemetry payload was not a string; ignoring payload.');
      lastParseWarning = Date.now();
    }
    return;
  }
  const text = csvRemainder + payload;
  const lines = text.split(/\r?\n/);
  csvRemainder = lines.pop() ?? '';
  for (const line of lines) {
    const sample = parseTelemetryCsvLine(line);
    if (sample) {
      telemetryQueue.push(sample);
    }
  }
}

function flushTelemetryRemainder() {
  if (!csvRemainder) return;
  const sample = parseTelemetryCsvLine(csvRemainder);
  csvRemainder = '';
  if (sample) telemetryQueue.push(sample);
}

async function setupTelemetryConnection() {
  if (!conn) {
    console.warn('SignalR not found; you can feed telemetry via window.enqueueCsvTelemetry(csvText).');
    return;
  }
  const handlers = [
    'CsvTelemetry',
    'TelemetryCsv',
    'telemetryCsv',
    'Telemetry',
    'telemetry',
    'csv',
  ];
  handlers.forEach((eventName) => conn.on(eventName, ingestTelemetryCsvPayload));
  conn.on('telemetry', ingestTelemetryJsonPayload);
  try {
    await conn.start();
    console.info('Telemetry SignalR connection established.');
  } catch (err) {
    console.error('Failed to connect to telemetry SignalR hub:', err);
  }
}

function applyTelemetrySample(sample) {
  if (!sample) return;
  if (sample.gyro) gyro = sample.gyro;
  if (sample.acc) acc = sample.acc;
  if (sample.mag) mag = sample.mag;
  if (sample.pressure !== null && sample.pressure !== undefined) {
    P = sample.pressure;
  }
  if (sample.referencePressure !== null && sample.referencePressure !== undefined) {
    P0 = sample.referencePressure;
  } else if (forceReinitOnNextSample && sample.pressure !== null && sample.pressure !== undefined) {
    P0 = sample.pressure;
  }
  if (sample.declinationRad !== null && sample.declinationRad !== undefined) {
    decl = sample.declinationRad;
  }
  if (forceReinitOnNextSample && st.inited) {
    st.inited = false;
  }
  forceReinitOnNextSample = false;
}

function ingestTelemetryJsonPayload(payload) {
  if (!payload || payload.type !== 'telemetry') return;
  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  const alt = Number(payload.alt);
  if (![lat, lon, alt].every(Number.isFinite)) return;

  const rawTime = Number(payload.t);
  const when = Number.isFinite(rawTime)
    ? Cesium.JulianDate.addSeconds(
        Cesium.JulianDate.unixEpoch,
        rawTime / 1000,
        new Cesium.JulianDate()
      )
    : Cesium.JulianDate.now();

  directFixQueue.push({
    when,
    lat,
    lon,
    alt,
    yawDeg: Number(payload.yaw) || 0,
    pitchDeg: Number(payload.pitch) || 0,
    rollDeg: Number(payload.roll) || 0,
  });
  useDirectTelemetry = true;
}

function simulateNextSensorSample() {
  if (telemetryQueue.length === 0) {
    flushTelemetryRemainder();
    if (telemetryQueue.length === 0) return;
  }
  const sample = telemetryQueue.shift();
  applyTelemetrySample(sample);
}

// Expose helper for manual CSV injection (useful during development)
if (typeof window !== 'undefined') {
  window.enqueueCsvTelemetry = ingestTelemetryCsvPayload;
  window.resetInsStateFromTelemetry = () => {
    forceReinitOnNextSample = true;
  };
}

await setupTelemetryConnection();

// ---- Cesium setup ----
Cesium.Ion.defaultAccessToken =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0ZDEzYmIxOS0yNDk0LTQ0NDItYjNlNy03NWU4Y2I4N2EzY2IiLCJpZCI6MzUyMDI0LCJpYXQiOjE3NjA5MDUyMTR9.aAyv_MXnZaN9y2QgSNRglNe5JyAMouG9lnoXJtJ-61E';

const viewer = new Cesium.Viewer('cesiumContainer', {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  shouldAnimate: true,
});

// 1) ENU origin (your launch site)
const launchSite = { lon: 5.349723834309746, lat: 60.370157623938304, h: 100 };
const originFixed = Cesium.Cartesian3.fromDegrees(launchSite.lon, launchSite.lat, launchSite.h);
const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(originFixed);

// ENU -> ECEF helper
function enuToEcef(e, n, u) {
  const local = new Cesium.Cartesian3(e, n, u); // meters ENU
  return Cesium.Matrix4.multiplyByPoint(enuToFixed, local, new Cesium.Cartesian3());
}

// 2) Time-based property for smooth animation
const position = new Cesium.SampledPositionProperty();
position.setInterpolationOptions({
  interpolationAlgorithm: Cesium.LinearApproximation,
  interpolationDegree: 1,
});


const rocketPathStyle = {
  show: true,
  width: 6,
  trailTime: 60,
  material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.25, color: Cesium.Color.RED }),
};

const rocketEntityOptions = {
  position,
  path: rocketPathStyle,
  model: {
    uri: 'models/Rocket.glb',
    minimumPixelSize: 32,
    maximumScale: 500,
    silhouetteColor: Cesium.Color.WHITE,
    silhouetteSize: 1,
  },
};

const rocket = viewer.entities.add(rocketEntityOptions);
viewer.trackedEntity = rocket;

// 4) Clock for live-style playback
viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
viewer.clock.multiplier = 1;
viewer.clock.shouldAnimate = true;

// ---- INS setup ----
// Core state objects declared earlier so telemetry handlers can mutate them safely.

// First update initializes state
ins_update(st, gyro, acc, mag, P, P0, decl, dtINS, cf);

// Seed a little history so the path shows immediately
const t0 = Cesium.JulianDate.now();
for (let k = 0; k <= 5; k++) {
  const tk = Cesium.JulianDate.addSeconds(t0, -5 + k, new Cesium.JulianDate());
  const pk = enuToEcef(st.p_e.x, st.p_e.y, st.p_e.z);
  position.addSample(tk, pk);
}

// If you have real sensors, set gyro/acc/mag/P here instead of simulateNextSensorSample().

// Visual sampling rate (lower than INS rate is fine; Cesium interpolates)
const visualDt = 0.01; // 20 Hz
setInterval(() => {
  if (useDirectTelemetry && directFixQueue.length) {
    const fix = directFixQueue.shift();
    const pos = Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat, fix.alt);
    position.addSample(fix.when, pos);

    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians(fix.yawDeg),
      Cesium.Math.toRadians(fix.pitchDeg),
      Cesium.Math.toRadians(fix.rollDeg)
    );
    rocket.orientation = new Cesium.ConstantProperty(
      Cesium.Transforms.headingPitchRollQuaternion(pos, hpr)
    );

    if (Cesium.JulianDate.greaterThan(fix.when, viewer.clock.currentTime)) {
      viewer.clock.currentTime = fix.when;
    }

    const newStop = Cesium.JulianDate.addSeconds(fix.when, 120, new Cesium.JulianDate());
    if (!viewer.clock.stopTime || Cesium.JulianDate.greaterThan(newStop, viewer.clock.stopTime)) {
      viewer.clock.stopTime = newStop;
    }
    return;
  }

  // Run INS multiple steps per visual frame
  const steps = Math.max(1, Math.round(visualDt / dtINS));
  for (let i = 0; i < steps; i++) {
    simulateNextSensorSample();
    ins_update(st, gyro, acc, mag, P, P0, decl, dtINS, cf);
  }

  // Add a Cesium sample at current time using absolute ENU position
  const now = Cesium.JulianDate.now();
  const ecef = enuToEcef(st.p_e.x, st.p_e.y, st.p_e.z);
  position.addSample(now, ecef);

  // Orientation from INS (yaw/pitch/roll around ENU)
  const {roll, pitch, yaw} = euler_from_q(st.q);
  const hpr = new Cesium.HeadingPitchRoll(yaw, pitch, roll);
  rocket.orientation = new Cesium.ConstantProperty(
    Cesium.Transforms.headingPitchRollQuaternion(ecef, hpr)
  );

  // Extend stopTime so timeline keeps flowing
  const newStop = Cesium.JulianDate.addSeconds(now, 120, new Cesium.JulianDate());
  if (!viewer.clock.stopTime || Cesium.JulianDate.greaterThan(newStop, viewer.clock.stopTime)) {
    viewer.clock.stopTime = newStop;
  }
}, visualDt * 1000);

// Optional: initial camera move
viewer.zoomTo(rocket);
})();
