(function () {
    function initCfdFlow() {
        const canvas = document.getElementById('cfdCanvas');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const SPEED_OF_SOUND_MS = 230;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        let width = 0;
        let height = 0;
        let rafId = 0;
        let startTime = performance.now();

        function resize() {
            const cssWidth = canvas.clientWidth || 144;
            const cssHeight = canvas.clientHeight || 300;
            width = Math.max(1, Math.floor(cssWidth));
            height = Math.max(1, Math.floor(cssHeight));
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function smoothstep(edge0, edge1, x) {
            const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
            return t * t * (3 - 2 * t);
        }

        function getLiveSpeedMs() {
            const el = document.getElementById('circleVelValue');
            if (!el) return 0;
            const raw = (el.textContent || '').trim();
            if (!raw || raw === '-') return 0;
            const numeric = raw.replace(',', '.').replace(/[^0-9.+-]/g, '');
            const v = parseFloat(numeric);
            if (!Number.isFinite(v)) return 0;
            return Math.max(0, v);
        }

        function getTelemetryNorm() {
            return Math.max(0, Math.min(1, getLiveSpeedMs() / SPEED_OF_SOUND_MS));
        }

        function getRocketGeom() {
            const cx = width * 0.5;
            const tipY = height * 0.10;
            const noseH = height * 0.21;
            const noseBaseY = tipY + noseH;
            const bodyH = height * 0.52;
            const bodyBottomY = noseBaseY + bodyH;
            const bodyR = Math.min(width * 0.11, 16);
            const nozzleH = height * 0.09;
            const nozzleTopY = bodyBottomY;
            const nozzleBottomY = nozzleTopY + nozzleH;
            const nozzleTopR = bodyR;
            const nozzleBottomR = bodyR * 0.56;

            return {
                cx,
                tipY,
                noseH,
                noseBaseY,
                bodyBottomY,
                bodyR,
                nozzleTopY,
                nozzleBottomY,
                nozzleTopR,
                nozzleBottomR
            };
        }

        function noseRadiusAtY(y, g) {
            if (y <= g.tipY || y >= g.noseBaseY) return 0;
            const t = (y - g.tipY) / g.noseH;
            return g.bodyR * Math.pow(t, 0.58);
        }

        function rocketRadiusAtY(y, g) {
            if (y >= g.tipY && y < g.noseBaseY) return noseRadiusAtY(y, g);
            if (y >= g.noseBaseY && y <= g.bodyBottomY) return g.bodyR;
            if (y > g.nozzleTopY && y <= g.nozzleBottomY) {
                const t = (y - g.nozzleTopY) / (g.nozzleBottomY - g.nozzleTopY);
                return g.nozzleTopR + (g.nozzleBottomR - g.nozzleTopR) * t;
            }
            return 0;
        }

        function signedDistanceToRocket(x, y, g) {
            const r = rocketRadiusAtY(y, g);
            if (r <= 0) return Math.abs(x - g.cx) + 20;
            return Math.abs(x - g.cx) - r;
        }

        function surfaceNormalSign(x, g) {
            return x >= g.cx ? 1 : -1;
        }

        function surfaceSlope(y, g) {
            const eps = 1.2;
            const r1 = rocketRadiusAtY(y - eps, g);
            const r2 = rocketRadiusAtY(y + eps, g);
            return (r2 - r1) / (2 * eps);
        }

        function drawRocket(g, telemetryNorm) {
            const atSpeedOfSound = telemetryNorm >= 1;

            ctx.save();
            ctx.shadowColor = atSpeedOfSound ? 'rgba(255, 84, 84, 0.45)' : 'rgba(255, 255, 255, 0.35)';
            ctx.shadowBlur = 10;
            ctx.fillStyle = atSpeedOfSound ? 'rgba(255, 0, 0, 0.99)' : 'rgba(255, 255, 255, 0.98)';
            ctx.strokeStyle = atSpeedOfSound ? 'rgba(255, 70, 70, 1)' : 'rgba(238, 245, 255, 0.94)';
            ctx.lineWidth = 1.2;

            ctx.beginPath();
            ctx.moveTo(g.cx - g.bodyR, g.noseBaseY);
            ctx.lineTo(g.cx + g.bodyR, g.noseBaseY);
            ctx.lineTo(g.cx + g.bodyR, g.bodyBottomY);
            ctx.lineTo(g.cx - g.bodyR, g.bodyBottomY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(g.cx - g.bodyR, g.noseBaseY);
            ctx.bezierCurveTo(
                g.cx - g.bodyR * 1.0,
                g.tipY + g.noseH * 0.58,
                g.cx - g.bodyR * 0.28,
                g.tipY + g.noseH * 0.16,
                g.cx,
                g.tipY
            );
            ctx.bezierCurveTo(
                g.cx + g.bodyR * 0.28,
                g.tipY + g.noseH * 0.16,
                g.cx + g.bodyR * 1.0,
                g.tipY + g.noseH * 0.58,
                g.cx + g.bodyR,
                g.noseBaseY
            );
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(g.cx - g.nozzleTopR, g.nozzleTopY);
            ctx.lineTo(g.cx + g.nozzleTopR, g.nozzleTopY);
            ctx.lineTo(g.cx + g.nozzleBottomR, g.nozzleBottomY);
            ctx.lineTo(g.cx - g.nozzleBottomR, g.nozzleBottomY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            const grad = ctx.createLinearGradient(g.cx - g.bodyR, 0, g.cx + g.bodyR, 0);
            if (atSpeedOfSound) {
                grad.addColorStop(0, 'rgba(255, 40, 40, 0.22)');
                grad.addColorStop(0.5, 'rgba(255, 0, 0, 0.45)');
                grad.addColorStop(1, 'rgba(255, 40, 40, 0.22)');
            } else {
                grad.addColorStop(0, 'rgba(255,255,255,0.16)');
                grad.addColorStop(0.5, 'rgba(255,255,255,0.32)');
                grad.addColorStop(1, 'rgba(255,255,255,0.16)');
            }
            ctx.fillStyle = grad;
            ctx.fillRect(g.cx - g.bodyR, g.noseBaseY, g.bodyR * 2, g.bodyBottomY - g.noseBaseY);

            ctx.restore();
        }

        function drawTipBreak(g, t) {
            const r = g.bodyR * 1.15;
            const y = g.tipY + g.noseH * 0.20;
            const pulse = 0.75 + 0.25 * Math.sin(t * 2.1);

            ctx.save();
            ctx.globalAlpha = 0.68 * pulse;
            ctx.strokeStyle = 'rgba(255, 214, 90, 0.95)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 4]);
            ctx.lineDashOffset = -t * 22;
            ctx.beginPath();
            ctx.arc(g.cx, y, r, Math.PI * 0.18, Math.PI * 0.82, true);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        function flowColor(speedNorm, telemetryNorm) {
            const local = Math.max(0, Math.min(1, speedNorm));
            const mach = Math.max(0, Math.min(1, telemetryNorm));
            const baseHue = 120 * (1 - mach); // green -> red with live speed
            const hue = Math.max(0, Math.min(120, baseHue - local * 10));
            const sat = 86 + local * 8;
            const light = 56 + local * 8;
            return `hsl(${hue}, ${sat}%, ${light}%)`;
        }

        function flowEdgeFade(x, y) {
            const sidePad = width * 0.12;
            const topPad = height * 0.13;
            const bottomPad = height * 0.18;

            const left = smoothstep(0, sidePad, x);
            const right = 1 - smoothstep(width - sidePad, width, x);
            const top = smoothstep(0, topPad, y);
            const bottom = 1 - smoothstep(height - bottomPad, height, y);

            return Math.max(0, Math.min(left, right, top, bottom));
        }
        function sampleVelocity(x, y, g, telemetryNorm, timeSec) {
            let vx = 0;
            let vy = 2.12;

            const relX = x - g.cx;
            const sign = relX === 0 ? 1 : Math.sign(relX);
            const absX = Math.abs(relX);

            const tipDx = absX;
            const tipDy = y - (g.tipY + g.noseH * 0.17);
            const tipInf = Math.exp(-((tipDx * tipDx) / (g.bodyR * g.bodyR * 1.55) + (tipDy * tipDy) / (g.noseH * g.noseH * 0.82)));
            vx += sign * tipInf * 3.0;
            vy -= tipInf * 0.55;
            // Pre-tip convergence: flow gathers toward centerline before split.
            const approachBlend = 1 - smoothstep(g.tipY - g.noseH * 0.28, g.tipY + g.noseH * 0.08, y);
            vx += (-relX / Math.max(g.bodyR * 3.2, 1)) * approachBlend * 1.05;

            // Center-fed incoming stream that splits around the nose/body.
            const coreX = Math.exp(-(relX * relX) / (g.bodyR * g.bodyR * 2.6));
            const coreY = Math.exp(-((y - (g.tipY - g.noseH * 0.05)) * (y - (g.tipY - g.noseH * 0.05))) / (g.noseH * g.noseH * 3.0));
            const centerFeed = coreX * coreY;
            const splitRamp = smoothstep(g.tipY - g.noseH * 0.02, g.noseBaseY + g.bodyR * 0.75, y);
            vx += sign * centerFeed * splitRamp * 2.2;
            vy += centerFeed * 0.52;

            const d = signedDistanceToRocket(x, y, g);
            const outsideD = Math.max(0, d);
            const nearSurface = Math.exp(-((outsideD * outsideD) / (g.bodyR * g.bodyR * 0.18)));
            const band = y >= g.tipY && y <= g.nozzleBottomY + height * 0.04 ? 1 : 0;

            // Stronger outward expansion the closer we are to sonic speed,
            // increasing from upper body toward the nozzle/wake region.
            const sonicFactor = Math.pow(Math.max(0, Math.min(1, telemetryNorm)), 1.7);
            const downstream = smoothstep(g.noseBaseY, g.nozzleBottomY + height * 0.12, y);
            const expansion = sonicFactor * downstream;

            if (band) {
                const slope = surfaceSlope(y, g);
                const s = surfaceNormalSign(x, g);
                const tx = s * slope;
                const ty = 1;
                const tLen = Math.max(0.001, Math.hypot(tx, ty));
                const tnx = tx / tLen;
                const tny = ty / tLen;

                vx += tnx * nearSurface * 3.1;
                vy += tny * nearSurface * 1.15;

                vx += sign * nearSurface * expansion * 2.6;
                vy += nearSurface * expansion * 0.22;
            }

            if (d < 2.1 && band) {
                const push = (2.1 - d) / Math.max(g.bodyR, 1);
                vx += sign * push * (3.9 + expansion * 2.2);
                vy += push * (0.65 + expansion * 0.25);
            }

            const wakeDy = y - g.nozzleBottomY;
            if (wakeDy > 0) {
                const wakeInf = Math.exp(-((relX * relX) / (g.bodyR * g.bodyR * 2.3) + (wakeDy * wakeDy) / (height * height * 0.062)));
                const wakeExpand = sonicFactor * smoothstep(0, height * 0.34, wakeDy);
                vx += (-relX / Math.max(g.bodyR * 2.9, 1)) * wakeInf * 0.6;
                vx += sign * wakeInf * wakeExpand * 0.9;
                vy += wakeInf * (0.14 + wakeExpand * 0.08);

                // Small rolling eddies in the lower wake (counter-rotating pair).
                const vortexSpread = 1 + wakeExpand * 0.55;
                const vortexY = g.nozzleBottomY + height * (0.09 + wakeExpand * 0.06);
                const leftX = g.cx - g.bodyR * 1.18 * vortexSpread;
                const rightX = g.cx + g.bodyR * 1.18 * vortexSpread;

                const swirlAmp = (0.45 + wakeExpand * 0.65) * (0.88 + 0.12 * Math.sin(timeSec * 2.6));

                const dxL = x - leftX;
                const dyL = y - vortexY;
                const r2L = dxL * dxL + dyL * dyL + 14;
                vx += (-dyL / r2L) * swirlAmp * 8.0;
                vy += (dxL / r2L) * swirlAmp * 8.0;

                const dxR = x - rightX;
                const dyR = y - vortexY;
                const r2R = dxR * dxR + dyR * dyR + 14;
                vx += (dyR / r2R) * swirlAmp * 8.0;
                vy += (-dxR / r2R) * swirlAmp * 8.0;
            }

            return { vx, vy };
        }


        function drawFlow(timeSec, g, telemetryNorm) {
            ctx.clearRect(0, 0, width, height);

            const glow = ctx.createRadialGradient(g.cx, (g.tipY + g.nozzleBottomY) * 0.5, g.bodyR * 1.4, g.cx, (g.tipY + g.nozzleBottomY) * 0.5, height * 0.42);
            glow.addColorStop(0, 'rgba(30, 120, 220, 0.10)');
            glow.addColorStop(1, 'rgba(30, 120, 220, 0.0)');
            ctx.fillStyle = glow;
            ctx.fillRect(0, 0, width, height);

            const streamCount = 62;
            const seedTop = -36;
            const step = 2.9;
            const maxSteps = Math.floor((height + 64) / step);
            const dashSpeed = 110;

            for (let i = 0; i < streamCount; i++) {
                const lane = (i + 0.5) / streamCount;
                const centeredLane = 0.5 + (lane - 0.5) * 0.90;
                const laneShape = Math.sin((i / Math.max(1, streamCount - 1)) * Math.PI);
                let x = width * (centeredLane + Math.sin(i * 1.31) * 0.012 * laneShape);
                let y = seedTop - (i % 9) * 2.2;

                let prevX = x;
                let prevY = y;

                ctx.setLineDash([7, 10]);
                ctx.lineDashOffset = -(timeSec * dashSpeed + i * 13);

                for (let k = 0; k < maxSteps; k++) {
                    const v1 = sampleVelocity(x, y, g, telemetryNorm, timeSec);
                    const mx = x + v1.vx * step * 0.2;
                    const my = y + v1.vy * step * 0.5;
                    const v2 = sampleVelocity(mx, my, g, telemetryNorm, timeSec);

                    x += v2.vx * step * 0.38;
                    y += v2.vy * step;

                    const speed = Math.sqrt(v2.vx * v2.vx + v2.vy * v2.vy);
                    const sNorm = Math.min(1, speed / 3.3);

                    const alpha = flowEdgeFade((prevX + x) * 0.5, (prevY + y) * 0.5);
                    if (alpha > 0.01) {
                        ctx.globalAlpha = 0.85 * alpha;
                        ctx.strokeStyle = flowColor(sNorm, telemetryNorm);
                        ctx.lineWidth = 1.12;
                        ctx.beginPath();
                        ctx.moveTo(prevX, prevY);
                        ctx.lineTo(x, y);
                        ctx.stroke();
                    }

                    prevX = x;
                    prevY = y;

                    if (y > height + 30 || x < -40 || x > width + 40) break;
                }
            }

            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
            drawTipBreak(g, timeSec);
        }

        function animate(now) {
            const t = (now - startTime) / 1000;
            const g = getRocketGeom();
            const telemetryNorm = getTelemetryNorm();
            drawFlow(t, g, telemetryNorm);
            drawRocket(g, telemetryNorm);
            rafId = window.requestAnimationFrame(animate);
        }

        resize();
        if (rafId) window.cancelAnimationFrame(rafId);
        rafId = window.requestAnimationFrame(animate);

        window.addEventListener('resize', resize);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCfdFlow, { once: true });
    } else {
        initCfdFlow();
    }
})();










