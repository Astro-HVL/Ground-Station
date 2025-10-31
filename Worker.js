// ----------------- Math helpers -----------------
const g0 = 9.80665; // m/s^2

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  add(o) { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  mul(s) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  addInPlace(o){ this.x += o.x; this.y += o.y; this.z += o.z; return this; }
}

function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a,b){
  return new Vec3(
    a.y*b.z - a.z*b.y,
    a.z*b.x - a.x*b.z,
    a.x*b.y - a.y*b.x
  );
}
function norm(a){ return Math.sqrt(Math.max(1e-18, dot(a,a))); }
function normalize(a){ const n = norm(a); return new Vec3(a.x/n, a.y/n, a.z/n); }

class Quat {
  // w + xi + yj + zk
  constructor(w=1, x=0, y=0, z=0){ this.w=w; this.x=x; this.y=y; this.z=z; }
  static fromAxisAngle(axis, angle){
    const a = angle * 0.5;
    const s = Math.sin(a);
    const n = Math.sqrt(Math.max(1e-18, axis.x*axis.x + axis.y*axis.y + axis.z*axis.z));
    const u = (n>0) ? new Vec3(axis.x/n, axis.y/n, axis.z/n) : new Vec3(1,0,0);
    return new Quat(Math.cos(a), u.x*s, u.y*s, u.z*s);
  }
  // q * r
  mul(q){
    const aw=this.w, ax=this.x, ay=this.y, az=this.z;
    const bw=q.w, bx=q.x, by=q.y, bz=q.z;
    return new Quat(
      aw*bw - ax*bx - ay*by - az*bz,
      aw*bx + ax*bw + ay*bz - az*by,
      aw*by - ax*bz + ay*bw + az*bx,
      aw*bz + ax*by - ay*bx + az*bw
    );
  }
  conj(){ return new Quat(this.w, -this.x, -this.y, -this.z); }
  normalizeSelf(){
    const n = Math.sqrt(Math.max(1e-18, this.w*this.w + this.x*this.x + this.y*this.y + this.z*this.z));
    this.w/=n; this.x/=n; this.y/=n; this.z/=n; return this;
  }
}

// R_b2e * v = rotate body->ENU using quaternion q (passive rotation)
function rotate_b2e(q, v){
  const p = new Quat(0, v.x, v.y, v.z);
  const qc = q.conj();
  const r = q.mul(p).mul(qc);
  return new Vec3(r.x, r.y, r.z);
}

// --- Complementary filter params ---
class CFParams {
  constructor(alpha_rp=0.02, alpha_yaw=0.02, alpha_h=0.05){
    this.alpha_rp = alpha_rp; // roll/pitch blending from accel (0..1)
    this.alpha_yaw = alpha_yaw; // yaw blending from mag (0..1)
    this.alpha_h = alpha_h; // baro height blending
  }
}

// --- State container ---
class INSState {
  constructor(){
    this.q = new Quat(); // attitude body->ENU
    this.v_e = new Vec3(0,0,0); // ENU velocity
    this.p_e = new Vec3(0,0,0); // ENU position relative to start
    this.dp_e = new Vec3(0,0,0); // last-step position increment
    this.ba = new Vec3(0,0,0); // accel bias
    this.bg = new Vec3(0,0,0); // gyro bias
    this.h_baro = 0; // low-passed baro height
    this.inited = false;
  }
}

// --- Heading and baro helpers ---
// Tilt-compensated magnetometer -> yaw (rad). q is body->ENU.
function yaw_from_mag(q, m_body, declination_rad){
  const m_e = rotate_b2e(q, m_body); // mag in ENU
  const psi_mag = Math.atan2(m_e.x, m_e.y); // atan2(E, N)
  let psi_true = psi_mag + declination_rad;
  while (psi_true >  Math.PI) psi_true -= 2*Math.PI;
  while (psi_true < -Math.PI) psi_true += 2*Math.PI;
  return psi_true;
}

// Barometric altitude from pressure P [Pa] and reference P0 [Pa]
function baro_altitude(P, P0){
  const P0s = Math.max(1.0, P0);
  return 44330.0 * (1.0 - Math.pow(P / P0s, 0.190263));
}

// Extract yaw/pitch/roll from quaternion for blending/logging (aerospace ZYX)
function euler_from_q(q){
  const sinr_cosp = 2*(q.w*q.x + q.y*q.z);
  const cosr_cosp = 1 - 2*(q.x*q.x + q.y*q.y);
  const roll = Math.atan2(sinr_cosp, cosr_cosp);

  const sinp = 2*(q.w*q.y - q.z*q.x);
  const pitch = (Math.abs(sinp) >= 1) ? Math.sign(sinp)*(Math.PI/2) : Math.asin(sinp);

  const siny_cosp = 2*(q.w*q.z + q.x*q.y);
  const cosy_cosp = 1 - 2*(q.y*q.y + q.z*q.z);
  const yaw = Math.atan2(siny_cosp, cosy_cosp);

  return {roll, pitch, yaw};
}

// Set yaw in quaternion (keep roll/pitch) by rotating around ENU U-axis (z)
function set_yaw(q, yaw_new){
  const {yaw: y} = euler_from_q(q);
  const dy = yaw_new - y;
  const d = Quat.fromAxisAngle(new Vec3(0,0,1), dy);
  const out = d.mul(q);
  return out.normalizeSelf();
}

// Blend roll/pitch with accelerometer (gravity vector)
function blend_roll_pitch_with_accel(q, acc_body, alpha_rp){
  const g_e = new Vec3(0,0,-g0);
  // ENU->body: use q_conj
  const q_conj = new Quat(q.w, -q.x, -q.y, -q.z);
  const g_b_pred = rotate_b2e(q_conj, g_e);

  const gm = new Vec3(-acc_body.x, -acc_body.y, -acc_body.z); // approx gravity in body
  if (norm(gm) < 1e-3 || norm(g_b_pred) < 1e-3) return q;

  const u1 = normalize(g_b_pred);
  const u2 = normalize(gm);
  let axis = cross(u1,u2);
  const s = norm(axis);
  const c = Math.max(-1.0, Math.min(1.0, dot(u1,u2)));
  const angle = Math.atan2(s, c);
  if (s > 1e-6){
    axis = axis.mul(1.0/s);
    const dq = Quat.fromAxisAngle(axis, alpha_rp * angle);
    const out = dq.mul(q);
    return out.normalizeSelf();
  }
  return q;
}

// --- Main update per time step ---
function ins_update(st,
  gyro_b_rad_s,   // Vec3 p,q,r (rad/s)
  acc_b_mps2,     // Vec3 specific force (m/s^2)
  mag_b,          // Vec3 magnetometer (calibrated)
  pressure_Pa, P0_Pa,
  declination_rad,
  dt,
  cf = new CFParams()
){
  // 0) Init on first call: coarse attitude from accel + mag
  if (!st.inited){
    const a = acc_b_mps2;
    if (norm(a) < 1e-3) return; // not enough info

    // Build rotation that takes body-z to ENU-up aligned with -acc
    const gm = normalize(new Vec3(-a.x, -a.y, -a.z));
    const z_b = new Vec3(0,0,1);
    let axis_b = cross(z_b, gm);
    const s = norm(axis_b);
    const c = Math.max(-1.0, Math.min(1.0, dot(z_b, gm)));
    const angle = Math.atan2(s, c);
    const q0 = (s>1e-6) ? Quat.fromAxisAngle(axis_b.mul(1.0/s), angle) : new Quat();
    q0.normalizeSelf();

    const yaw0 = yaw_from_mag(q0, mag_b, declination_rad);
    st.q = set_yaw(q0, yaw0);
    st.h_baro = baro_altitude(pressure_Pa, P0_Pa);
    st.inited = true;
    return;
  }

  // 1) Remove biases
  const omega = new Vec3(
    gyro_b_rad_s.x - st.bg.x,
    gyro_b_rad_s.y - st.bg.y,
    gyro_b_rad_s.z - st.bg.z
  );
  const f_b = new Vec3(
    acc_b_mps2.x - st.ba.x,
    acc_b_mps2.y - st.ba.y,
    acc_b_mps2.z - st.ba.z
  );

  // 2) Integrate attitude from gyro (quaternion)
  const ang = norm(omega) * dt;
  let dq;
  if (ang > 1e-9) dq = Quat.fromAxisAngle(omega, ang); else dq = new Quat(1,0,0,0);
  st.q = st.q.mul(dq);
  st.q.normalizeSelf();

  // 3) Complementary correction: roll/pitch from accel, yaw from mag
  st.q = blend_roll_pitch_with_accel(st.q, f_b, cf.alpha_rp);

  const yaw_meas = yaw_from_mag(st.q, mag_b, declination_rad);
  const {yaw: y_est} = euler_from_q(st.q);
  let dy = yaw_meas - y_est;
  while (dy >  Math.PI) dy -= 2*Math.PI;
  while (dy < -Math.PI) dy += 2*Math.PI;
  st.q = set_yaw(st.q, y_est + cf.alpha_yaw * dy);

  // 4) Acceleration in ENU: a_e = R_b2e * f_b + g_e
  const a_e = rotate_b2e(st.q, f_b).add(new Vec3(0,0,-g0));

  // 5) Integrate velocity and position
  const v_prev = new Vec3(st.v_e.x, st.v_e.y, st.v_e.z);
  st.v_e = st.v_e.add(a_e.mul(dt));
  const dp = v_prev.mul(dt).add(a_e.mul(0.5 * dt * dt));
  st.dp_e = dp;
  st.p_e = st.p_e.add(dp);

  // 6) Baro height and blending into U
  const h_meas = baro_altitude(pressure_Pa, P0_Pa);
  st.h_baro = (1.0 - cf.alpha_h) * st.h_baro + cf.alpha_h * h_meas;
  const du = st.h_baro - st.p_e.z;
  st.p_e.z += cf.alpha_h * du;
  st.v_e.z += cf.alpha_h * (du / Math.max(1e-3, dt));

  // Optional: print JSON for visualization (matches C++)
  // console.log(JSON.stringify({ dE: st.dp_e.x, dN: st.dp_e.y, dU: st.dp_e.z }));
}

// ------------------- DEMO -------------------
// Run `node ins_js_port.js` to see a short simulation, or import the functions/classes in a web app.
if (typeof module !== 'undefined' && require.main === module){
  const st = new INSState();
  const cf = new CFParams();
  const dt = 0.01; // 100 Hz

  const P0 = 101325.0; // Pa
  let gyro = new Vec3(0,0,0);
  let acc  = new Vec3(0,0,-g0);
  const mag  = new Vec3(0.2, 0.0, -0.45);
  let P = P0;
  const decl = 0.0;

  // first call will init
  ins_update(st, gyro, acc, mag, P, P0, decl, dt, cf);

  for (let k=0; k<500; ++k){
    const t = k*dt;
    gyro = new Vec3(0, 0, 5.0 * Math.PI/180.0); // 5 deg/s yaw
    if (t > 0.2){
      acc = new Vec3(0, 0, -g0 + 2.0); // upward accel
      // crude inverse baro for demo (matches C++)
      P = P0 * Math.pow(1 - ((st.p_e.z + 0.1) / 44330.0), 1/0.190263);
    }
    ins_update(st, gyro, acc, mag, P, P0, decl, dt, cf);
  }

  const {roll:r, pitch:p, yaw:y} = euler_from_q(st.q);
  console.log(`p_e [E N U] = ${st.p_e.x.toFixed(3)}  ${st.p_e.y.toFixed(3)}  ${st.p_e.z.toFixed(3)} m`);
  console.log(`v_e [E N U] = ${st.v_e.x.toFixed(3)}  ${st.v_e.y.toFixed(3)}  ${st.v_e.z.toFixed(3)} m/s`);
  console.log(`Euler [roll pitch yaw] = ${(r*180/Math.PI).toFixed(2)}  ${(p*180/Math.PI).toFixed(2)}  ${(y*180/Math.PI).toFixed(2)} deg`);
  console.log(`Baro h = ${st.h_baro.toFixed(2)} m`);
}

// Exports for module usage
export {
  Vec3, Quat, CFParams, INSState,
  g0,
  dot, cross, norm, normalize,
  rotate_b2e,
  yaw_from_mag, baro_altitude, euler_from_q, set_yaw, blend_roll_pitch_with_accel,
  ins_update
};
