// live_data.js - connects to SignalR telemetry hub and updates the live page
const conn = new signalR.HubConnectionBuilder().withUrl('/telemetry').withAutomaticReconnect().build();

// DOM elements
let circleAlt, circleVel, circleG;
let modeOn, modeReady, modePending, modeApogee, modeParachute;
let flightTimerEl;

// debug status
let __statusBox = null;
function ensureStatusBox() {
  if (__statusBox) return __statusBox;
  __statusBox = document.createElement('div');
  __statusBox.id = '__live_data_status';
  Object.assign(__statusBox.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    padding: '8px 12px',
    background: 'rgba(0,0,0,0.6)',
    color: '#fff',
    fontSize: '12px',
    borderRadius: '8px',
    zIndex: 9999
  });
  __statusBox.textContent = 'live_data: init';
  document.body.appendChild(__statusBox);
  return __statusBox;
}
function setStatus(text) {
  try {
    ensureStatusBox().textContent = 'live_data: ' + text;
  } catch (e) {
    console.debug('status update failed', e);
  }
}

function lockLivePageScroll() {
  const root = document.documentElement;
  const body = document.body;

  function applyLock() {
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.inset = '0';
    body.style.width = '100%';
    body.style.height = '100%';
    window.scrollTo(0, 0);
  }

  applyLock();
  window.addEventListener('resize', applyLock);
  window.addEventListener('scroll', () => window.scrollTo(0, 0), { passive: true });

  const preventPageWheel = (e) => {
    const target = e.target;
    if (target && target.closest && target.closest('#cesiumFrame')) return;
    e.preventDefault();
  };
  document.addEventListener('wheel', preventPageWheel, { passive: false });
  document.addEventListener('touchmove', preventPageWheel, { passive: false });
}

// ---------- Mode helpers ----------
function setActiveMode(name) {
  [modeOn, modeReady, modePending, modeApogee, modeParachute].forEach((el) => {
    if (!el) return;
    el.classList.remove('active-mode');
  });
  const map = {
    on: modeOn,
    ready: modeReady,
    pending: modePending,
    apogee: modeApogee,
    parachute: modeParachute
  };
  const el = map[name];
  if (el) el.classList.add('active-mode');
}

// ---------- Charts ----------
let altChart;
function createAltChart() {
  const el = document.getElementById('altitudeChart');
  if (!el) return;
  const ctx = el.getContext('2d');
  altChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Altitude (m)',
          data: [],
          borderColor: 'magenta',
          fill: false,
          yAxisID: 'y_alt',
          pointRadius: 1
        }
      ]
    },
    options: {
      animation: false,
      responsive: false,
      maintainAspectRatio: true,
      scales: {
        x: {
          display: true,
          title: { display: true, text: 'Time (s)', color: '#fff', font: { size: 18 } },
          ticks: { color: '#fff' },
          grid: { color: 'rgba(255,255,255,0.15)' },
          border: { color: '#fff' }
        },
        y_alt: {
          title: { display: true, text: 'Altitude (m)', color: '#fff', font: { size: 18 } },
          ticks: { color: '#fff' },
          grid: { color: 'rgba(255,255,255,0.15)' },
          border: { color: '#fff' }
        }
      },
      plugins: { legend: { labels: { color: '#fff' } } }
    }
  });
}

function pushAltitude(timeSec, alt) {
  if (!altChart || !Number.isFinite(timeSec)) return;
  altChart.data.labels.push(timeSec.toFixed(3));
  altChart.data.datasets[0].data.push(Number.isFinite(alt) ? alt : null);
  if (altChart.data.labels.length > 300) {
    altChart.data.labels.shift();
    altChart.data.datasets[0].data.shift();
  }
  altChart.update('none');
}

// ---------- Metric updater ----------
function updateMetrics(alt, vel, ax, ay, az) {
  if (circleAlt) circleAlt.textContent = Number.isFinite(alt) ? alt.toFixed(0) : '-';
  if (circleVel) circleVel.textContent = Number.isFinite(vel) ? vel.toFixed(1) : '-';
  if (circleG) {
    const hasAccel = [ax, ay, az].every((v) => Number.isFinite(v));
    const g = hasAccel ? Math.sqrt(ax * ax + ay * ay + az * az) : NaN;
    circleG.textContent = Number.isFinite(g) ? g.toFixed(2) : '-';
  }
}

// ---------- Fallback 2D rocket ----------
function createFallbackRocket() {
  const container = document.getElementById('rocket3dContainer');
  if (!container) return null;
  const canvas = document.createElement('canvas');
  canvas.width = container.clientWidth || 220;
  canvas.height = container.clientHeight || 220;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  container.innerHTML = '';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function draw(pitch = 0, yaw = 0, roll = 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height - 20);
    ctx.rotate((yaw || 0) * Math.PI / 180);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -80);
    ctx.lineTo(12, -30);
    ctx.lineTo(6, -30);
    ctx.lineTo(6, 0);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-6, -30);
    ctx.lineTo(-12, -30);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  return { draw };
}

if (typeof initRocket3D !== 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    const fb = createFallbackRocket();
    if (fb) window.setRocket3DRotation = (p, y, r) => fb.draw(p, y, r);
  });
}

// ---------- Telemetry handling ----------
conn.on('telemetry', (payload) => {
  try {
    if (payload.type === 'telemetry') {
      const state = Number(payload.state);
      const timeSec = Number(payload.t);
      const alt = Number(payload.alt);
      const vel = Number(payload.vel);
      const ax = Number(payload.ax);
      const ay = Number(payload.ay);
      const az = Number(payload.az);
      const pitch = Number(payload.pitch);
      const roll = Number(payload.roll);
      const yaw = Number(payload.yaw);

      if (flightTimerEl) {
        flightTimerEl.textContent = Number.isFinite(timeSec)
          ? `Flight duration: ${timeSec.toFixed(2)} s`
          : 'Flight duration: -';
      }

      updateMetrics(alt, vel, ax, ay, az);
      if (typeof setRocket3DRotation === 'function') {
        setRocket3DRotation(pitch, yaw, roll);
      }

      // Only plot altitude once the vehicle is active
      if ([3, 4, 5].includes(state)) {
        pushAltitude(timeSec, alt);
      }
// Fjern blinke faenskap eventuelt lol
      switch (state) {
        case 1:
          setActiveMode('on');
          document.body.classList.remove('blink-red');
          break; // System Check
        case 2:
          setActiveMode('ready');
          document.body.classList.remove('blink-red');
          break; // Launch Ready
        case 3:
          setActiveMode('pending');
          document.body.classList.remove('blink-red');
          break; // Launch
        case 4:
          setActiveMode('apogee');
          document.body.classList.remove('blink-red');
          break; // Apogee
        case 5:
          setActiveMode('parachute');
          document.body.classList.add('blink-red');
          break; // Parachute Deploy
      }
    } else if (payload.type === 'json' && payload.data) {
      const st = payload.data.state;
      switch (st) {
        case 1:
          setActiveMode('on');
          document.body.classList.remove('blink-red');
          break;
        case 2:
          setActiveMode('ready');
          document.body.classList.remove('blink-red');
          break;
        case 3:
          setActiveMode('pending');
          document.body.classList.remove('blink-red');
          break;
        case 4:
          setActiveMode('apogee');
          document.body.classList.remove('blink-red');
          break;
        case 5:
          setActiveMode('parachute');
          document.body.classList.add('blink-red');
          break;
      }
    }
  } catch (e) {
    console.error('telemetry parse error', e);
  }
});

// ---------- Connection start ----------
async function startConn() {
  try {
    await conn.start();
    setStatus('connected');
  } catch (e) {
    console.error('connection start failed', e);
    setStatus('retry...');
    setTimeout(startConn, 2000);
  }
}

// ---------- DOM ready ----------
document.addEventListener('DOMContentLoaded', () => {
  lockLivePageScroll();

  circleAlt = document.getElementById('circleAltValue');
  circleVel = document.getElementById('circleVelValue');
  circleG = document.getElementById('circleGValue');
  modeOn = document.getElementById('modeOn');
  modeReady = document.getElementById('modeReady');
  modePending = document.getElementById('modePending');
  modeApogee = document.getElementById('modeApogee');
  modeParachute = document.getElementById('modeParachute');
  flightTimerEl = document.getElementById('flightTimer');

  const cesiumFrame = document.getElementById('cesiumFrame');
  if (cesiumFrame) {
    cesiumFrame.addEventListener('load', () => setStatus('cesium frame loaded'));
    cesiumFrame.addEventListener('error', () => setStatus('cesium frame failed'));
  } else {
    setStatus('cesium frame missing');
  }

  if (typeof initRocket3D === 'function') {
    if (!window.__rocket3d_inited) {
      window.__rocket3d_inited = true;
      setTimeout(() => {
        try {
          initRocket3D();
        } catch (e) {
          console.error(e);
        }
      }, 100);
    }
  } else {
    setStatus('3D not found');
  }

  createAltChart();
  startConn();
  setActiveMode('on'); // default: System Check
});
