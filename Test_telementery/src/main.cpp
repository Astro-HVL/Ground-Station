#include <Arduino.h>
#include <math.h>

unsigned long seq = 0;

// Base constants
const float G0 = 9.81f; // m/s^2
const float DT_FALLBACK = 0.15f;
const float DEG2RAD = 0.01745329252f;
const float RAD2DEG = 57.2957795f;
const float INITIAL_STATIC_SECONDS = 1.0f;
const float SIM_TIME_SCALE = 0.35f; // <1 slows the whole flight timeline.
const float BOOST_NET_ACCEL = 38.0f; // m/s^2 net upward during boost.
const float BOOST_BURN_SECONDS = 7.0f;
const float CHUTE_DEPLOY_ALT = 700.0f; // meters above ground.
const float PITCH_OUTPUT_OFFSET_DEG = -90.0f; // Align test pitch to GLB frame.

// State variables
float t = 0.0f;     // seconds
float alt = 0.0f;   // meters
float vel = 0.0f;   // m/s (up)
float pitch = 0.0f; // degrees
float roll = 0.0f;
float yaw = 0.0f;

// Drift (wind)
float east = 0.0f;  // meters
float north = 0.0f; // meters
const float windEast = 2.0f;  // m/s
const float windNorth = 0.5f; // m/s

// Start position (degrees)
const float baseLat = 60.3701576f;
const float baseLon = 5.3497238f;

unsigned long lastMs = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
  randomSeed(analogRead(A0));
}

float pressureAtHeight(float h) {
  if (h < 11000) return 101325 * pow(1 - 0.0065 * h / 288.15, 5.2561);
  else if (h < 20000) return 22632 * exp(-0.000157 * (h - 11000));
  else if (h < 32000) return 5474 * pow(1 + 0.001 * (h - 20000) / 216.65, -34.1632);
  else if (h < 47000) return 868 * pow(1 - 0.0028 * (h - 32000) / 228.65, 12.2016);
  else if (h < 51000) return 110 * exp(-0.000157 * (h - 47000));
  else if (h < 71000) return 66 * pow(1 - 0.0028 * (h - 51000) / 270.65, -12.2016);
  else return 0.12;
}

float temperatureAtHeight(float h) {
  if (h < 11000) return 15 - 0.0065 * h;
  else if (h < 20000) return -56.5;
  else if (h < 32000) return -56.5 + 0.001 * (h - 20000);
  else if (h < 47000) return -44.5 + 0.0028 * (h - 32000);
  else if (h < 51000) return -2.5;
  else if (h < 71000) return -2.5 - 0.0028 * (h - 51000);
  else return -58.5;
}

float wrapAngle180(float angleDeg) {
  while (angleDeg > 180.0f) angleDeg -= 360.0f;
  while (angleDeg < -180.0f) angleDeg += 360.0f;
  return angleDeg;
}

void loop() {
  unsigned long now = millis();
  float dt = lastMs == 0 ? DT_FALLBACK : (now - lastMs) / 1000.0f;
  float simDt = dt * SIM_TIME_SCALE;
  lastMs = now;
  t += simDt;

  int state = 0;     // 0=idle,1=boost,2=coast,3=descent,4=chute,5=landed
  float acc = 0.0f;  // m/s^2 (up)

  const float boostEndTime = INITIAL_STATIC_SECONDS + BOOST_BURN_SECONDS;

  if (t < INITIAL_STATIC_SECONDS) {
    state = 0;
    vel = 0.0f;
    alt = 0.0f;
    acc = 0.0f;
  } else if (t < boostEndTime) {
    state = 1;
    acc = BOOST_NET_ACCEL;
  } else if (alt <= 0.0f && vel <= 0.0f) {
    state = 5;
    vel = 0.0f;
    alt = 0.0f;
    acc = 0.0f;
  } else if (vel > 0.0f) {
    state = 2;
    acc = -G0; // coast
  } else if (alt > CHUTE_DEPLOY_ALT) {
    state = 3;
    acc = -G0; // descent before chute
  } else {
    state = 4;
    float targetVel = -15.0f; // m/s terminal with chute
    float newVel = vel + (targetVel - vel) * 0.2f;
    acc = (newVel - vel) / simDt;
    vel = newVel;
  }

  if (state != 0 && state != 4 && state != 5) {
    vel += acc * simDt;
  }

  alt += vel * simDt;
  if (alt < 0.0f) {
    alt = 0.0f;
    vel = 0.0f;
    state = 5;
    acc = 0.0f;
  }

  // Wind drift only while airborne
  if (state != 0 && state != 5) {
    east += windEast * simDt;
    north += windNorth * simDt;
  }

  // Small random lateral accelerations (m/s^2)
  float ax = random(-20, 20) / 100.0f; // -0.2..0.2
  float ay = random(-20, 20) / 100.0f;
  float az = acc;

  if (state == 0) {
    ax = 0.0f;
    ay = 0.0f;
    az = 0.0f;
    pitch = 0.0f;
    roll = 0.0f;
    yaw = 0.0f;
  }

  float metersPerDegLat = 111320.0f;
  float metersPerDegLon = 111320.0f * cos(baseLat * DEG2RAD);
  float lat = baseLat + (north / metersPerDegLat);
  float lon = baseLon + (east / metersPerDegLon);

  float vE = (state == 0 || state == 5) ? 0.0f : windEast;
  float vN = (state == 0 || state == 5) ? 0.0f : windNorth;
  float h = sqrt(vE * vE + vN * vN);
  if (h > 0.01f) {
    yaw = atan2(vE, vN) * RAD2DEG;
  }
  if (h > 0.01f) {
    pitch = atan2(vel, h) * RAD2DEG;
  } else {
    pitch = vel > 0.1f ? 90.0f : (vel < -0.1f ? -90.0f : 0.0f);
  }
  float pitchOut = wrapAngle180(pitch + PITCH_OUTPUT_OFFSET_DEG);
  roll = 0.0f;

  // Pressure and temperature
  float press = pressureAtHeight(alt);
  float temp  = temperatureAtHeight(alt);

  // Send CSV:
  // t,seq,ax,ay,az,pitch,roll,yaw,temp,vel,press,lat,lon,alt,state
  Serial.print(t, 2); Serial.print(',');
  Serial.print(seq++); Serial.print(',');
  Serial.print(ax, 3); Serial.print(',');
  Serial.print(ay, 3); Serial.print(',');
  Serial.print(az, 3); Serial.print(',');
  Serial.print(pitchOut, 2); Serial.print(',');
  Serial.print(roll, 2); Serial.print(',');
  Serial.print(yaw, 2); Serial.print(',');
  Serial.print(temp, 2); Serial.print(',');
  Serial.print(vel, 2); Serial.print(',');
  Serial.print(press, 2); Serial.print(',');
  Serial.print(lat, 6); Serial.print(',');
  Serial.print(lon, 6); Serial.print(',');
  Serial.print(alt, 2); Serial.print(',');
  Serial.print(state); Serial.print('\n');

  delay(150);
}
