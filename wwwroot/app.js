const connection = new signalR.HubConnectionBuilder()
    .withUrl("/telemetry")
    .withAutomaticReconnect()
    .build();

const debugEl = document.getElementById('debug');
function dbg(message) {
  if (debugEl) {
    debugEl.textContent = `${message}\n${debugEl.textContent}`;
    if (debugEl.textContent.length > 8000) {
      debugEl.textContent = debugEl.textContent.slice(0, 8000);
    }
  } else {
    console.debug(message);
  }
}

const BLINK_PITCH_THRESHOLD_DEG = -1.5;
const MAX_DATA_POINTS = 2000;

// DOM elements
const valTime = document.getElementById('val_time');
const valSeq = document.getElementById('val_seq');
const valAx = document.getElementById('val_ax');
const valAy = document.getElementById('val_ay');
const valAz = document.getElementById('val_az');
const valPitch = document.getElementById('val_pitch');
const valRoll = document.getElementById('val_roll');
const valYaw = document.getElementById('val_yaw');
const valTemp = document.getElementById('val_temp');
const valVel = document.getElementById('val_vel');
const valPress = document.getElementById('val_press');
const valLat = document.getElementById('val_lat');
const valLon = document.getElementById('val_lon');
const valAlt = document.getElementById('val_alt');
const timerValueEl = document.getElementById('timerValue');

// Visualization DOM elements (top-level)
const pitchViz = document.getElementById('pitchViz');
const yawViz = document.getElementById('yawViz');
const rollViz = document.getElementById('rollViz');
const pitchValue = document.getElementById('pitchValue');
const yawValue = document.getElementById('yawValue');
const rollValue = document.getElementById('rollValue');

const dashboardTitle = document.querySelector('h1');
const defaultDashboardTitle = dashboardTitle ? dashboardTitle.textContent : '';

// Draw default orientation figures (0 deg) on page load
window.addEventListener('DOMContentLoaded', () => {
  if (pitchViz) drawRocket(pitchViz.getContext('2d'), 0);
  if (yawViz) drawRocket(yawViz.getContext('2d'), 0);
  if (rollViz) drawRoll(rollViz.getContext('2d'), 0);
  if (pitchValue) pitchValue.textContent = '0.00 \u00B0';
  if (yawValue) yawValue.textContent = '0.00 \u00B0';
  if (rollValue) rollValue.textContent = '0.00 \u00B0';
});

function drawRocket(ctx, angleDeg) {
  // Draw a simple rocket shape centered and rotated by angleDeg
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, -40); // nose
  ctx.lineTo(12, 20); // right body
  ctx.lineTo(6, 20); // right fin top
  ctx.lineTo(18, 40); // right fin tip
  ctx.lineTo(0, 28); // bottom
  ctx.lineTo(-18, 40); // left fin tip
  ctx.lineTo(-6, 20); // left fin top
  ctx.lineTo(-12, 20); // left body
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawRoll(ctx, angleDeg) {
  // Draw a circle with a line indicating roll angle
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.beginPath();
  ctx.arc(0, 0, 32, 0, 2 * Math.PI);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Draw roll indicator line
  ctx.save();
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -32);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
  // Draw 3 small lines for reference
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.rotate(((i * 120) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -40);
    ctx.strokeStyle = '#fff8';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function updateOrientationVisuals(pitch, yaw, roll) {
  if (pitchViz && Number.isFinite(pitch)) {
    drawRocket(pitchViz.getContext('2d'), pitch);
  }
  if (yawViz && Number.isFinite(yaw)) {
    drawRocket(yawViz.getContext('2d'), yaw);
  }
  if (rollViz && Number.isFinite(roll)) {
    drawRoll(rollViz.getContext('2d'), roll);
  }
  if (pitchValue && Number.isFinite(pitch)) {
    pitchValue.textContent = `${pitch.toFixed(2)} \u00B0`;
  }
  if (yawValue && Number.isFinite(yaw)) {
    yawValue.textContent = `${yaw.toFixed(2)} \u00B0`;
  }
  if (rollValue && Number.isFinite(roll)) {
    rollValue.textContent = `${roll.toFixed(2)} \u00B0`;
  }
}

function formatNumber(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '-';
}

function normalizeLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat: null, lon: null };
  }

  const directValid = lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  if (directValid && (Math.abs(lat) > 1e-6 || Math.abs(lon) > 1e-6)) {
    return { lat, lon };
  }

  const microLat = lat / 1e6;
  const microLon = lon / 1e6;
  const microValid =
    microLat >= -90 &&
    microLat <= 90 &&
    microLon >= -180 &&
    microLon <= 180 &&
    (Math.abs(microLat) > 1e-6 || Math.abs(microLon) > 1e-6);

  return microValid ? { lat: microLat, lon: microLon } : { lat: null, lon: null };
}

function updateBlinkState(pitchDeg) {
  const warning = Number.isFinite(pitchDeg) && pitchDeg <= BLINK_PITCH_THRESHOLD_DEG;
  document.body.classList.toggle('blink-red', warning);
  if (dashboardTitle) {
    dashboardTitle.textContent = warning ? 'WARNING: Altitude dropping' : defaultDashboardTitle;
  }
}

function updateLatest(timeSec, seqValue, ax, ay, az, pitch, roll, yaw, temp, vel, press, lat, lon, alt) {
  const timeStr = Number.isFinite(timeSec) ? `${timeSec.toFixed(3)} s` : '-';
  if (valTime) valTime.textContent = timeStr;
  if (timerValueEl) timerValueEl.textContent = timeStr;
  if (valSeq) valSeq.textContent = seqValue ?? '-';
  if (valAx) valAx.textContent = formatNumber(ax, 3);
  if (valAy) valAy.textContent = formatNumber(ay, 3);
  if (valAz) valAz.textContent = formatNumber(az, 3);
  if (valPitch) valPitch.textContent = formatNumber(pitch, 2);
  if (valRoll) valRoll.textContent = formatNumber(roll, 2);
  if (valYaw) valYaw.textContent = formatNumber(yaw, 2);
  if (valTemp) valTemp.textContent = formatNumber(temp, 2);
  if (valVel) valVel.textContent = formatNumber(vel, 2);
  if (valPress) valPress.textContent = formatNumber(press, 3);
  const normalizedGps = normalizeLatLon(lat, lon);
  if (valLat) {
    valLat.textContent = Number.isFinite(normalizedGps.lat) ? normalizedGps.lat.toFixed(6) : '-';
  }
  if (valLon) {
    valLon.textContent = Number.isFinite(normalizedGps.lon) ? normalizedGps.lon.toFixed(6) : '-';
  }
  if (valAlt) valAlt.textContent = Number.isFinite(alt) ? Number(alt).toFixed(0) : '-';

  if (typeof setRocket3DRotation === 'function') {
    setRocket3DRotation(pitch, yaw, roll);
  }

  updateOrientationVisuals(pitch, yaw, roll);

  if (velChart?.data?.datasets?.[0]) {
    velChart.data.datasets[0].label = `Velocity: ${formatNumber(vel, 2)} m/s`;
  }
  if (altChart?.data?.datasets?.[0]) {
    altChart.data.datasets[0].label = `Altitude: ${formatNumber(alt, 0)} m`;
  }
  if (orientChart?.data?.datasets?.length === 3) {
    orientChart.data.datasets[0].label = 'Pitch (\u00B0)';
    orientChart.data.datasets[1].label = 'Roll (\u00B0)';
    orientChart.data.datasets[2].label = 'Yaw (\u00B0)';
  }
  if (tempChart?.data?.datasets?.[0]) {
    tempChart.data.datasets[0].label = `Temperature: ${formatNumber(temp, 2)} \u00B0C`;
  }
  if (pressChart?.data?.datasets?.[0]) {
    pressChart.data.datasets[0].label = `Pressure: ${formatNumber(press, 3)} atm`;
  }
}

let velChart;
let altChart;
let accChart;
let orientChart;
let tempChart;
let pressChart;

function createCharts() {
  const xAxisOptions = {
    display: true,
    min: 0,
    title: { display: true, text: 'Time (s)', font: { size: 20 }, color: '#fff' },
    ticks: {
      font: { size: 14 },
      color: '#fff',
      callback(value, index, ticks) {
        const label = this.getLabelForValue(index);
        return label ? Number(label).toFixed(3) : '';
      }
    }
  };

  const baseOptions = {
    animation: false,
    responsive: false,
    maintainAspectRatio: true,
    plugins: { legend: { labels: { font: { size: 20 }, color: '#fff' } } }
  };

  const velCanvas = document.getElementById('velChart');
  if (velCanvas) {
    const ctx = velCanvas.getContext('2d');
    velChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Velocity (m/s)', data: [], borderColor: 'goldenrod', borderWidth: 2, fill: false, yAxisID: 'y_vel', pointRadius: 1 }]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y_vel: { title: { display: true, text: 'Velocity (m/s)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }

  const altCanvas = document.getElementById('altChart');
  if (altCanvas) {
    const ctx = altCanvas.getContext('2d');
    altChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Altitude (m)', data: [], borderColor: 'magenta', fill: false, yAxisID: 'y_alt', pointRadius: 1 }]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y_alt: { title: { display: true, text: 'Altitude (m)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }

  const tempCanvas = document.getElementById('tempChart');
  if (tempCanvas) {
    const ctx = tempCanvas.getContext('2d');
    tempChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Temperature (\u00B0C)', data: [], borderColor: 'brown', fill: false, pointRadius: 1 }]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y: { title: { display: true, text: 'Temp (\u00B0C)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }

  const pressCanvas = document.getElementById('pressChart');
  if (pressCanvas) {
    const ctx = pressCanvas.getContext('2d');
    pressChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Pressure (atm)', data: [], borderColor: 'gray', fill: false, pointRadius: 1 }]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y: { title: { display: true, text: 'Pressure (atm)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }

  const accCanvas = document.getElementById('accChart');
  if (accCanvas) {
    const ctx = accCanvas.getContext('2d');
    accChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'ax (g)', data: [], borderColor: 'red', fill: false, pointRadius: 1 },
          { label: 'ay (g)', data: [], borderColor: 'green', fill: false, pointRadius: 1 },
          { label: 'az (g)', data: [], borderColor: 'blue', fill: false, pointRadius: 1 }
        ]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y: { title: { display: true, text: 'Acceleration (g)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }

  const orientCanvas = document.getElementById('orientChart');
  if (orientCanvas) {
    const ctx = orientCanvas.getContext('2d');
    orientChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Pitch (\u00B0)', data: [], borderColor: 'orange', fill: false, pointRadius: 1 },
          { label: 'Roll (\u00B0)', data: [], borderColor: 'purple', fill: false, pointRadius: 1 },
          { label: 'Yaw (\u00B0)', data: [], borderColor: 'teal', fill: false, pointRadius: 1 }
        ]
      },
      options: {
        ...baseOptions,
        scales: {
          x: { ...xAxisOptions },
          y: { title: { display: true, text: 'Orientation (\u00B0)', font: { size: 20 }, color: '#fff' }, ticks: { font: { size: 14 }, color: '#fff' } }
        }
      }
    });
  }
}

function pushToCharts(timeSec, ax, ay, az, pitch, roll, yaw, temp, vel, press, alt) {
  if (!Number.isFinite(timeSec)) return;
  const label = timeSec.toFixed(3);

  if (velChart) {
    velChart.data.labels.push(label);
    velChart.data.datasets[0].data.push(Number.isFinite(vel) ? vel : null);
    trimChart(velChart);
    velChart.update('none');
  }

  if (altChart) {
    altChart.data.labels.push(label);
    altChart.data.datasets[0].data.push(Number.isFinite(alt) ? alt : null);
    trimChart(altChart);
    altChart.update('none');
  }

  if (accChart) {
    accChart.data.labels.push(label);
    accChart.data.datasets[0].data.push(Number.isFinite(ax) ? ax : null);
    accChart.data.datasets[1].data.push(Number.isFinite(ay) ? ay : null);
    accChart.data.datasets[2].data.push(Number.isFinite(az) ? az : null);
    trimChart(accChart);
    accChart.update('none');
  }

  if (orientChart) {
    orientChart.data.labels.push(label);
    orientChart.data.datasets[0].data.push(Number.isFinite(pitch) ? pitch : null);
    orientChart.data.datasets[1].data.push(Number.isFinite(roll) ? roll : null);
    orientChart.data.datasets[2].data.push(Number.isFinite(yaw) ? yaw : null);
    trimChart(orientChart);
    orientChart.update('none');
  }

  if (tempChart) {
    tempChart.data.labels.push(label);
    tempChart.data.datasets[0].data.push(Number.isFinite(temp) ? temp : null);
    trimChart(tempChart);
    tempChart.update('none');
  }

  if (pressChart) {
    pressChart.data.labels.push(label);
    pressChart.data.datasets[0].data.push(Number.isFinite(press) ? press : null);
    trimChart(pressChart);
    pressChart.update('none');
  }
}

function trimChart(chart) {
  while (chart.data.labels.length > MAX_DATA_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
}

connection.on('telemetry', (payload) => {
  try {
    if (payload.type === 'telemetry') {
      const timeSec = Number(payload.t);
      const seqValue = Number.isFinite(payload.seq) ? payload.seq : (payload.seqRaw ?? null);
      const ax = Number(payload.ax);
      const ay = Number(payload.ay);
      const az = Number(payload.az);
      const pitch = Number(payload.pitch);
      const roll = Number(payload.roll);
      const yaw = Number(payload.yaw);
      const temp = Number(payload.temp);
      const vel = Number(payload.vel);
      const press = Number(payload.press);
      const lat = Number(payload.lat);
      const lon = Number(payload.lon);
      const alt = Number(payload.alt);

      updateLatest(timeSec, seqValue, ax, ay, az, pitch, roll, yaw, temp, vel, press, lat, lon, alt);
      pushToCharts(timeSec, ax, ay, az, pitch, roll, yaw, temp, vel, press, alt);
      updateBlinkState(pitch);
    } else {
      dbg('RAW: ' + JSON.stringify(payload));
    }
  } catch (err) {
    dbg('Error parsing payload: ' + err);
  }
});

async function start() {
  createCharts();

  if (typeof initRocket3D === 'function') {
    initRocket3D();
  } else {
    setTimeout(() => {
      if (typeof initRocket3D === 'function') initRocket3D();
    }, 500);
  }

  try {
    await connection.start();
    dbg('Connected to SignalR hub');
  } catch (err) {
    dbg('SignalR start failed: ' + err);
    setTimeout(start, 2000);
  }
}

start();
