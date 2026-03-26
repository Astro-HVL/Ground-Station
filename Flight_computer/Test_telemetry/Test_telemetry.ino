// ============================================================================
// Test_telemetry.ino
// Upload to any Arduino-compatible board (Uno, Nano, ESP32, etc.)
// Connect the board's USB serial to the ground station at 115200 baud.
//
// Simulates a rocket launched at 15° off vertical heading West.
// Accelerometer values are in g units to match the real flight computer.
//
// CSV format: t,seq,ax,ay,az,pitch,roll,yaw,temp,vel,press,lat,lon,alt,state
//   pitch: 0 = vertical (straight up), 90 = horizontal  (rocket convention)
//   yaw:   0 = North, 90 = East, 270 = West             (compass, CW)
//   ax/ay/az: g units  (1.0 g = 9.81 m/s²)
//   lat/lon:  0,0  — no GPS, forces IMU dead-reckoning in ground station
// ============================================================================

#include <math.h>

// ── Tuneable parameters — adjust these to match your real rocket ─────────────
const float SIM_SCALE   = 0.35f;  // <1 slows flight relative to wall clock (0.35 = ~3× slower)
const float PAD_SECONDS = 2.0f;   // seconds static on pad before ignition
const float LAUNCH_PITCH = 15.0f; // degrees off vertical
const float LAUNCH_YAW   = 270.0f;// compass heading of launch (270 = West)
const float BOOST_G      = 25.0f; // axial specific force during boost (g)
const float BURN_SEC     = 3.0f;  // motor burn time (sim seconds)
const float CHUTE_ALT    = 500.0f;// altitude AGL at which chute deploys (m)
const float CHUTE_VEL    = -8.0f; // terminal descent velocity under chute (m/s, negative = down)
// ─────────────────────────────────────────────────────────────────────────────

const float G0      = 9.81f;
const float DEG2RAD = 0.01745329252f;
const float RAD2DEG = 57.2957795f;

unsigned long seq    = 0;
unsigned long lastMs = 0;

float t      = 0.0f;
float vUp    = 0.0f;
float vEast  = 0.0f;
float vNorth = 0.0f;
float posUp    = 0.0f;
float posEast  = 0.0f;
float posNorth = 0.0f;

// Launch-axis unit vector in ENU, computed once in setup()
float axisUp    = 0.0f;
float axisEast  = 0.0f;
float axisNorth = 0.0f;

// ── Atmosphere ───────────────────────────────────────────────────────────────
float pressureAtHeight(float h) {
  if (h < 0.0f)     return 101325.0f;
  if (h < 11000.0f) return 101325.0f * pow(1.0f - 0.0065f * h / 288.15f, 5.2561f);
  if (h < 20000.0f) return 22632.0f  * exp(-0.000157f * (h - 11000.0f));
  if (h < 32000.0f) return 5474.0f   * pow(1.0f + 0.001f * (h - 20000.0f) / 216.65f, -34.163f);
  return 868.0f;
}

float temperatureAtHeight(float h) {
  if (h < 0.0f)     return 15.0f;
  if (h < 11000.0f) return 15.0f - 0.0065f * h;
  if (h < 20000.0f) return -56.5f;
  if (h < 32000.0f) return -56.5f + 0.001f * (h - 20000.0f);
  return -44.5f;
}

// ── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(1000);
  randomSeed(analogRead(A0));

  float sp = sin(LAUNCH_PITCH * DEG2RAD); // sin(15°) ≈  0.259
  float cp = cos(LAUNCH_PITCH * DEG2RAD); // cos(15°) ≈  0.966
  float sy = sin(LAUNCH_YAW   * DEG2RAD); // sin(270°) = -1.000
  float cy = cos(LAUNCH_YAW   * DEG2RAD); // cos(270°) =  0.000
  axisUp    = cp;       //  0.966
  axisEast  = sp * sy;  // -0.259 (westward)
  axisNorth = sp * cy;  //  0.000
}

// ── Main loop ────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();
  float dt    = (lastMs == 0) ? 0.15f : (now - lastMs) / 1000.0f;
  float simDt = dt * SIM_SCALE;
  lastMs = now;
  t += simDt;

  const float boostEnd = PAD_SECONDS + BURN_SEC;

  int   state = 0;
  float ax_g  = 0.0f;
  float ay_g  = 0.0f;
  float az_g  = 1.0f;  // gravity reaction when stationary

  // ── State machine ──────────────────────────────────────────────────────────
  if (t < PAD_SECONDS) {
    // Sitting on pad — everything reset, waiting for launch
    state = 0;
    vUp = vEast = vNorth = posUp = posEast = posNorth = 0.0f;
    az_g = 1.0f;

  } else if (t < boostEnd) {
    // Motor firing
    state = 1;
    az_g = BOOST_G;
    ax_g = (float)random(-15, 15) / 1000.0f;  // ±0.015 g lateral noise
    ay_g = (float)random(-15, 15) / 1000.0f;

    // True ENU acceleration:  a = R * (specificForce_body) + gravity_ENU
    // specificForce ≈ (0, 0, BOOST_G * G0) along rocket axis
    vUp    += (BOOST_G * G0 * axisUp    - G0) * simDt;
    vEast  += (BOOST_G * G0 * axisEast       ) * simDt;
    vNorth += (BOOST_G * G0 * axisNorth      ) * simDt;

  } else if (posUp <= 0.0f && t > boostEnd + 0.5f) {
    // Landed
    state = 5;
    vUp = vEast = vNorth = 0.0f;
    posUp = 0.0f;
    az_g  = 1.0f;

  } else if (posUp <= CHUTE_ALT && vUp < 0.0f) {
    // Descending under parachute
    state = 4;
    vUp    += (CHUTE_VEL - vUp) * 0.05f;  // bleed toward terminal velocity
    vEast  *= 0.97f;
    vNorth *= 0.97f;
    az_g = 0.3f + (float)random(-5, 5) / 1000.0f;  // chute drag ≈ 0.3 g upward
    ax_g = (float)random(-5, 5) / 1000.0f;
    ay_g = (float)random(-5, 5) / 1000.0f;

  } else if (vUp < 0.0f) {
    // Free descent above chute deployment altitude
    state = 3;
    vUp    -= G0 * simDt;
    vEast  *= 0.9995f;
    vNorth *= 0.9995f;
    az_g = 0.03f + (float)random(-5, 5) / 1000.0f;  // near-weightless
    ax_g = (float)random(-5, 5) / 1000.0f;
    ay_g = (float)random(-5, 5) / 1000.0f;

  } else {
    // Coasting upward (motor burned out)
    state = 2;
    vUp    -= G0 * simDt;
    vEast  *= 0.9995f;
    vNorth *= 0.9995f;
    az_g = 0.02f + (float)random(-5, 5) / 1000.0f;  // near-weightless
    ax_g = (float)random(-5, 5) / 1000.0f;
    ay_g = (float)random(-5, 5) / 1000.0f;
  }

  // ── Integrate position ────────────────────────────────────────────────────
  if (state != 0 && state != 5) {
    posUp    += vUp    * simDt;
    posEast  += vEast  * simDt;
    posNorth += vNorth * simDt;
    if (posUp < 0.0f) { posUp = 0.0f; vUp = 0.0f; }
  }

  // ── Orientation ───────────────────────────────────────────────────────────
  float pitch, yaw;
  const float roll = 0.0f;

  if (state == 0 || state == 1 || state == 5) {
    // Locked to launch rail
    pitch = LAUNCH_PITCH;
    yaw   = LAUNCH_YAW;
  } else {
    // Free flight: orientation follows velocity vector
    float hSpeed = sqrt(vEast * vEast + vNorth * vNorth);
    float speed  = sqrt(vUp * vUp + hSpeed * hSpeed);
    if (speed > 0.5f) {
      pitch = atan2(hSpeed, vUp) * RAD2DEG;  // 0=up, 90=horizontal
      if (hSpeed > 0.5f) {
        yaw = atan2(vEast, vNorth) * RAD2DEG;
        if (yaw < 0.0f) yaw += 360.0f;
      } else {
        yaw = LAUNCH_YAW;
      }
    } else {
      pitch = LAUNCH_PITCH;
      yaw   = LAUNCH_YAW;
    }
  }

  // ── Output fields ─────────────────────────────────────────────────────────
  float speed3d = sqrt(vUp * vUp + vEast * vEast + vNorth * vNorth);
  float vel     = (vUp < 0.0f && state >= 3) ? -speed3d : speed3d;
  float altOut  = posUp + (float)random(-5, 5) / 100.0f;  // baro with tiny noise
  float press   = pressureAtHeight(posUp);
  float temp    = temperatureAtHeight(posUp);

  // lat/lon = 0,0 → ground station uses IMU dead-reckoning (no GPS)
  float lat = 0.0f;
  float lon = 0.0f;

  // ── CSV: t,seq,ax,ay,az,pitch,roll,yaw,temp,vel,press,lat,lon,alt,state ────
  Serial.print(t, 2);      Serial.print(',');
  Serial.print(seq++);     Serial.print(',');
  Serial.print(ax_g, 4);   Serial.print(',');
  Serial.print(ay_g, 4);   Serial.print(',');
  Serial.print(az_g, 4);   Serial.print(',');
  Serial.print(pitch, 2);  Serial.print(',');
  Serial.print(roll, 2);   Serial.print(',');
  Serial.print(yaw, 2);    Serial.print(',');
  Serial.print(temp, 2);   Serial.print(',');
  Serial.print(vel, 2);    Serial.print(',');
  Serial.print(press, 2);  Serial.print(',');
  Serial.print(lat, 6);    Serial.print(',');
  Serial.print(lon, 6);    Serial.print(',');
  Serial.print(altOut, 2); Serial.print(',');
  Serial.println(state);

  delay(150);
}
