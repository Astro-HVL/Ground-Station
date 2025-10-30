#include <cmath>
#include <cstdio>
#include <algorithm>

struct Vec3 {
    double x=0, y=0, z=0;
    Vec3() = default;
    Vec3(double X,double Y,double Z):x(X),y(Y),z(Z){}
    Vec3 operator+(const Vec3& o) const { return {x+o.x,y+o.y,z+o.z}; }
    Vec3 operator-(const Vec3& o) const { return {x-o.x,y-o.y,z-o.z}; }
    Vec3 operator*(double s)     const { return {x*s,y*s,z*s}; }
    Vec3& operator+=(const Vec3& o){ x+=o.x; y+=o.y; z+=o.z; return *this; }
};

static inline double dot(const Vec3& a, const Vec3& b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
static inline Vec3 cross(const Vec3& a, const Vec3& b){
    return { a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x };
}
static inline double norm(const Vec3& a){ return std::sqrt(std::max(1e-18, dot(a,a))); }
static inline Vec3   normalize(const Vec3& a){ double n=norm(a); return {a.x/n,a.y/n,a.z/n}; }

struct Quat {
    // w + xi + yj + zk
    double w=1, x=0, y=0, z=0;
    Quat() = default;
    Quat(double W,double X,double Y,double Z):w(W),x(X),y(Y),z(Z){}
    static Quat fromAxisAngle(const Vec3& axis, double angle){
        double a = angle*0.5; double s = std::sin(a);
        Vec3 u = (norm(axis)>0? normalize(axis): Vec3{1,0,0});
        return {std::cos(a), u.x*s, u.y*s, u.z*s};
    }
    // q*this
    Quat operator*(const Quat& q) const {
        return {
            w*q.w - x*q.x - y*q.y - z*q.z,
            w*q.x + x*q.w + y*q.z - z*q.y,
            w*q.y - x*q.z + y*q.w + z*q.x,
            w*q.z + x*q.y - y*q.x + z*q.w
        };
    }
    void normalizeSelf(){
        double n = std::sqrt(std::max(1e-18, w*w+x*x+y*y+z*z));
        w/=n; x/=n; y/=n; z/=n;
    }
};

// R_b2e * v = rotate body->ENU using quaternion q (passive rotation)
static Vec3 rotate_b2e(const Quat& q, const Vec3& v){
    // v' = q * (0,v) * q_conj
    Quat p{0, v.x, v.y, v.z};
    Quat qc{q.w, -q.x, -q.y, -q.z};
    Quat r = q * p * qc;
    return {r.x, r.y, r.z};
}

// Sørg for riktig sgn-konvensjon: g peker ned i ENU ⇒ ge = (0,0,-g)
static constexpr double g0 = 9.80665;

// Komplementært filter-parametre (tuning)
struct CFParams {
    double alpha_rp = 0.02;  // lavpass innblanding roll/pitch (0..1) – høyere = mer fra aksel
    double alpha_yaw= 0.02;  // lavpass innblanding yaw fra magnetometer
    double alpha_h  = 0.05;  // lavpass innblanding baro-høyde
};

// Enkel tilstand
struct INSState {
    Quat  q;        // attitude body->ENU
    Vec3  v_e;      // ENU velocity [E,N,U]
    Vec3  p_e;      // ENU position [E,N,U] (relativt start)
    Vec3  dp_e;    // ENU pos endring siste steg
    Vec3  ba{0,0,0}; // accel bias (kan estimeres)
    Vec3  bg{0,0,0}; // gyro bias (kan estimeres)
    double h_baro = 0; // lavpasset baro-høyde
    bool   inited  = false;
};

// --- Hjelpefunksjoner for heading og baro ---
// Tilt-kompensert magnetometer → yaw (rad). q er body->ENU.
static double yaw_from_mag(const Quat& q, const Vec3& m_body, double declination_rad){
    Vec3 m_e = rotate_b2e(q, m_body);       // magnetvektor i ENU
    double psi_mag = std::atan2(m_e.x, m_e.y); // atan2(E, N)
    double psi_true = psi_mag + declination_rad;
    // Pakk inn til [-pi,pi]
    while (psi_true >  M_PI) psi_true -= 2*M_PI;
    while (psi_true < -M_PI) psi_true += 2*M_PI;
    return psi_true;
}

// Barometrisk høyde (meter) fra trykk P [Pa] og referansettrykk P0 [Pa]
static double baro_altitude(double P, double P0){
    // ISA 0-11 km
    return 44330.0 * (1.0 - std::pow(P / std::max(1.0,P0), 0.190263));
}

// Ekstraher yaw/pitch/roll fra kvaternion (for blending og logging)
static void euler_from_q(const Quat& q, double& roll, double& pitch, double& yaw){
    // ENU-konvensjon: yaw om U (z_e), pitch om E (x_e), roll om N (y_e) — her bruker vi vanlig aerospace (ZYX)
    double sinr_cosp = 2*(q.w*q.x + q.y*q.z);
    double cosr_cosp = 1 - 2*(q.x*q.x + q.y*q.y);
    roll = std::atan2(sinr_cosp, cosr_cosp);

    double sinp = 2*(q.w*q.y - q.z*q.x);
    pitch = std::abs(sinp) >= 1 ? std::copysign(M_PI/2, sinp) : std::asin(sinp);

    double siny_cosp = 2*(q.w*q.z + q.x*q.y);
    double cosy_cosp = 1 - 2*(q.y*q.y + q.z*q.z);
    yaw = std::atan2(siny_cosp, cosy_cosp);
}

// Sett yaw i kvaternion (behold roll/pitch) ved å rotere rundt U-aksen (ENU z)
static Quat set_yaw(const Quat& q, double yaw_new){
    // hent gjeldende yaw
    double r,p,y; euler_from_q(q,r,p,y);
    double dy = yaw_new - y;
    // rotasjon rundt ENU-U-aksen tilsvarer body->ENU post-multiplikasjon
    Quat d = Quat::fromAxisAngle({0,0,1}, dy);
    Quat out = d * q;
    out.normalizeSelf();
    return out;
}

// Bland roll/pitch med akselerometer (grav-vektor)
static Quat blend_roll_pitch_with_accel(const Quat& q, const Vec3& acc_body, double alpha_rp){
    // Forventet grav i ENU = (0,0,-g). Målte specific force (acc_body) ≈ a_specific.
    // Når stillestående er a_specific ≈ -R_e2b * g_e → vi bruker en "error tilt".
    Vec3 g_e{0,0,-g0};
    Vec3 g_b_pred = rotate_b2e(Quat{q.w,-q.x,-q.y,-q.z}, g_e); // ENU->body: q_conj
    // Error vektor mellom målt "grav" (≈ -acc_body når langsom bevegelse) og predikert:
    // Vi bruker en enkel vinkel mellom vektorer for å lage en korreksjonsrotasjon.
    Vec3 gm = acc_body * (-1.0); // grovt anslag på grav i body
    if (norm(gm) < 1e-3 || norm(g_b_pred) < 1e-3) return q;
    Vec3 u1 = normalize(g_b_pred);
    Vec3 u2 = normalize(gm);
    Vec3 axis = cross(u1,u2);
    double s = norm(axis);
    double c = std::clamp(dot(u1,u2), -1.0, 1.0);
    double angle = std::atan2(s, c);
    if (s > 1e-6){
        axis = axis * (1.0 / s);
        // demp korreksjon med alpha_rp
        Quat dq = Quat::fromAxisAngle(axis, alpha_rp * angle);
        Quat out = dq * q;
        out.normalizeSelf();
        return out;
    }
    return q;
}

// --- Hovedoppdatering per tidssteg ---
void ins_update(INSState& st,
                const Vec3& gyro_b_rad_s,      // p,q,r (rad/s)
                const Vec3& acc_b_mps2,        // specific force (m/s^2)
                const Vec3& mag_b,             // magnetometer (kalibrert), vilkårlige enheter
                double pressure_Pa, double P0_Pa,
                double declination_rad,
                double dt, const CFParams& cf = {})
{
    // 0) Init ved første kall: grov holdning fra aksel + mag
    if (!st.inited){
        // Roll/pitch fra aksel (grav peker -z_e)
        Vec3 a = acc_b_mps2;
        if (norm(a) < 1e-3) return;
        Vec3 z_e{0,0,1};
        // pitch: rot omkring E (x_e), roll: omkring N (y_e). Vi lager q som retter body-z mot -g_e.
        // En enkel måte: finn rotasjon som tar body-vektor gm = -acc_b til ENU (0,0,1).
        Vec3 gm = normalize(a * (-1.0));
        // ønsket ENU-up i body-ramme er gm; lag rotasjon fra body->ENU slik at body-z blir ENU-up.
        // Rotasjon fra body-z (0,0,1)_b til gm i body ⇒ axis = cross((0,0,1), gm) i body
        Vec3 z_b{0,0,1};
        Vec3 axis_b = cross(z_b, gm);
        double s = norm(axis_b);
        double c = std::clamp(dot(z_b, gm), -1.0, 1.0);
        double angle = std::atan2(s, c);
        Quat q0 = (s>1e-6)? Quat::fromAxisAngle(axis_b*(1.0/s), angle) : Quat{};
        q0.normalizeSelf();

        // Yaw fra magnetometer + deklinasjon
        double yaw0 = yaw_from_mag(q0, mag_b, declination_rad);
        st.q = set_yaw(q0, yaw0);
        st.h_baro = baro_altitude(pressure_Pa, P0_Pa);
        st.inited = true;
        return;
    }

    // 1) Fjern bias
    Vec3 omega = gyro_b_rad_s - st.bg;
    Vec3 f_b   = acc_b_mps2    - st.ba;

    // 2) Integrer attitude fra gyro (kvaternion)
    double angle = norm(omega) * dt;
    Quat dq = (angle > 1e-9) ? Quat::fromAxisAngle(omega, angle) : Quat{};
    if (angle <= 1e-9) dq = Quat{1,0,0,0};
    st.q = st.q * dq;          // body->ENU oppdatering
    st.q.normalizeSelf();

    // 3) Komplementær korreksjon: roll/pitch fra aksel, yaw fra mag
    st.q = blend_roll_pitch_with_accel(st.q, f_b, cf.alpha_rp);

    double yaw_meas = yaw_from_mag(st.q, mag_b, declination_rad);
    // bland yaw forsiktig
    double r,p,y_est; euler_from_q(st.q, r,p,y_est);
    // pakk differanse
    double dy = yaw_meas - y_est;
    while (dy >  M_PI) dy -= 2*M_PI;
    while (dy < -M_PI) dy += 2*M_PI;
    st.q = set_yaw(st.q, y_est + cf.alpha_yaw * dy);

   // 4) Akselerasjon i ENU: a_e = R_b2e * f_b + g_e  (husk: f_b er specific force)
Vec3 a_e = rotate_b2e(st.q, f_b) + Vec3{0,0,-g0};

// 5) Integrer hastighet og posisjon (bruk v_k i dp)
// lagre v_k før oppdatering:
Vec3 v_prev = st.v_e;

// oppdater hastighet til v_{k+1}:
st.v_e += a_e * dt;

// posisjonsinkrement for tidssteget: dp = v_k*dt + 0.5*a*dt^2
Vec3 dp = v_prev * dt + a_e * (0.5 * dt * dt);

// lagre og oppdater absolutt ENU-posisjon
st.dp_e = dp;
st.p_e  += dp;

// 6) Baro-høyde og blending inn i U
double h_meas = baro_altitude(pressure_Pa, P0_Pa);
st.h_baro = (1.0 - cf.alpha_h) * st.h_baro + cf.alpha_h * h_meas;

// tving posisjon U sakte mot baro-høyde (antatt p_e.z = U relativt start)
double du = st.h_baro - st.p_e.z;
st.p_e.z += cf.alpha_h * du;                         // pos-blending
st.v_e.z += cf.alpha_h * (du / std::max(1e-3, dt));  // liten hastighetsdemping

// (Valgfritt) send/print JSON for JavaScript-visualisering
std::printf("{\"dE\":%.4f,\"dN\":%.4f,\"dU\":%.4f}\n", st.dp_e.x, st.dp_e.y, st.dp_e.z);

}

// ------------------- DEMO -------------------
int main(){
    INSState st;
    CFParams cf;
    double dt = 0.01; // 100 Hz

    // Anta at vi står i ro på bakken, P0 kalibrert ved start:
    double P0 = 101325.0; // Pa
    // Sensor “målinger” (sett dine egne i loop):
    Vec3 gyro{0,0,0};            // rad/s
    Vec3 acc{0,0, -g0};          // specific force i body: stillestående peker ned -g på z_b
    Vec3 mag{0.2, 0.0, -0.45};   // vilkårlig, kalibrert
    double P = P0;               // Pa
    double decl = 0.0;           // magnetisk deklinasjon i rad (sett for din lokasjon)

    // Første kall initierer
    ins_update(st, gyro, acc, mag, P, P0, decl, dt, cf);

    // Simuler noen steg: liten yaw rotasjon + oppskyting (positiv U-aks)
    for (int k=0; k<500; ++k){
        // Eksempel-input: 5 deg/s yaw i 1 s, liten opp-accel etter 0.2 s
        double t = k*dt;
        gyro = {0, 0, (5.0 * M_PI/180.0)}; // 5 deg/s yaw
        if (t > 0.2){
            acc = {0, 0, -g0 + 2.0}; // 2 m/s^2 oppover (specific force ~ -g + thrust/gain)
            P = P0 * std::pow(1 - ( (st.p_e.z + 0.1) / 44330.0), 1/0.190263); // grov invers for demo
        }
        ins_update(st, gyro, acc, mag, P, P0, decl, dt, cf);
    }

    double r,p,y; euler_from_q(st.q,r,p,y);
    std::printf("p_e [E N U] = %.3f  %.3f  %.3f m\n", st.p_e.x, st.p_e.y, st.p_e.z);
    std::printf("v_e [E N U] = %.3f  %.3f  %.3f m/s\n", st.v_e.x, st.v_e.y, st.v_e.z);
    std::printf("Euler [roll pitch yaw] = %.2f  %.2f  %.2f deg\n",
                r*180/M_PI, p*180/M_PI, y*180/M_PI);
    std::printf("Baro h = %.2f m\n", st.h_baro);
    return 0;
}
