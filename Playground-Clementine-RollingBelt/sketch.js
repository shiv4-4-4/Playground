// Rolling Belt — Baby Balance (phone sketch)
// Libraries needed: p5.js 2.x + p5-phone (permission tap, gesture lock);
// audio uses baby-cry.mp3 file
// Phone is mounted on the flexible cardboard ring. Six people will roll it.
// Idea: a deformed ring does NOT roll with constant speed. So we do not
// judge "is speed constant?". We judge "is the rolling REPEATABLE?":
//   - rotation stays around one axis        (purity)
//   - speed profile per revolution repeats  (signature drift / period CV)
//   - no sudden bumps / reversals / stops   (impact, direction, speed gate)
//   - ripple (deformation) is tolerated up to a calibrated limit


// ---------- calibration ----------
let cfg = {
  speedFloor: 6,     // deg/s, below this we treat the ring as not rotating
  speedLo: 40,       // deg/s, slowest acceptable rolling speed
  speedHi: 260,      // deg/s, fastest acceptable rolling speed
  purityMin: 0.65,   // 0..1, share of rotation around the main roll axis
  rippleTol: 0.25,   // (max-min)/mean of speed inside one revolution
  devTol: 0.25,      // live deviation from last revolution's speed profile
  revTol: 0.15,      // revolution-to-revolution irregularity
  impactTol: 4.0,    // m/s^2, high-passed linear acceleration spike
  enterScore: 0.50,  // score needed to become "stable"
  exitScore: 0.30,   // score below which "stable" is lost
  enterHold: 0.8,    // s the score must stay high to become stable
  exitHold: 1.2,     // s the score must stay low to lose stability
  cryOnStop: true,   // baby also cries if the ring stops
  vibrate: true,
  sound: true
};

// ---------- app state ----------
let state = 'start';          // start | calibStill | calibRoll | play
let stateT0 = 0;
let msg = '';
let debugOn = true;
let lastTapMs = 0;
let audioOn = false;
let motionHooked = false;

// ---------- sensor ----------
const S = {
  has: false, lastT: 0, lastDataT: 0,
  bias: [0, 0, 0], rawW: [0, 0, 0],
  axis: [0, 0, 1], axisReady: false,
  wAxisS: 0, speedFast: 0, speedSlow: 0,
  pNum: 0, pDen: 1,
  ang: 0, lastWAxis: 0, jerk: 0,
  linLP: [0, 0, 0], impact: 0,
  dirSign: 0, reversalT: -99, slowT: 0,
  revStartAng: 0, revStartT: 0, revSamples: [],
  prevBins: null, prevMean: 0, periods: [], lastRev: null, devEMA: 0
};

// ---------- calibration buffers ----------
let cal = { still: [], speed: [], purity: [], ripple: [], dev: [], rev: [], impact: [] };

// ---------- baby / feedback state ----------
let M = null;                 // latest metrics
let stable = false, stableSince = null, unstableSince = null;
let cry = 0;                  // 0 calm .. 1 full cry
let graceUntil = 0, everStable = false, lastBumpT = -99;
let cryPhase = 0, voiceEnv = 0;

// =====================================================================
// p5 lifecycle
// =====================================================================
function setup() {
  createCanvas(windowWidth, windowHeight);
  textAlign(CENTER, CENTER);
  textFont('sans-serif');
  lockGestures();                  // no scrolling, zooming or pull to refresh
  enableGyroTap('Tap to start');   // a phone asks for the sensors only after a tap
  installInput();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function draw() {
  const now = performance.now() / 1000;
  const dt = Math.min(deltaTime / 1000, 0.1);

  // p5-phone finished the permission tap -> hook the sensor and start calibrating
  if (window.sensorsEnabled && !motionHooked) hookMotion();

  if (S.has && now - S.lastDataT > 0.5) decaySensors(dt); // sensor stalled

  M = computeMetrics(now);

  if (state === 'calibStill') runCalibStill(now);
  else if (state === 'calibRoll') runCalibRoll(now);
  else if (state === 'play') { updateStability(M, now); updateCry(M, now, dt); }
  else cry += (0 - cry) * (1 - Math.exp(-2 * dt));

  updateVoice(dt);
  drawScene();
}


// Input (touch + mouse, debounced)

// Native pointer events: work the same in p5 1.x and 2.x, on touch and mouse.
// The permission tap itself is handled by p5-phone (enableGyroTap).

function installInput() {
  // capture phase: the audio context must be created inside the user's tap,
  // even if p5-phone's overlay swallows the event afterwards.
  window.addEventListener('pointerdown', () => initAudio(), { capture: true });
  window.addEventListener('pointerdown', (e) => {
    const cnv = document.querySelector('canvas');
    const r = cnv.getBoundingClientRect();
    handleTap(e.clientX - r.left, e.clientY - r.top);
  });
}

function handleTap(x, y) {
  const t = performance.now();
  if (t - lastTapMs < 350) return;
  lastTapMs = t;

  if (x > width - 90 && y < 90) { debugOn = !debugOn; return; }

  if (state === 'play' && y > height * 0.82) { beginCalibration(); return; }
  if (state === 'play' && y < 90 && x < 90) { cfg.vibrate = !cfg.vibrate; return; }
}

function hookMotion() {
  motionHooked = true;
  initAudio();                                  // no-op if the tap already did it
  window.addEventListener('devicemotion', onMotion);
  beginCalibration();
}

// Sensor processing (runs at the sensor rate, faster than draw())

function onMotion(e) {
  const r = e.rotationRate;
  if (!r || r.alpha == null) return;

  const now = performance.now() / 1000;
  const dt = S.lastT ? Math.min(Math.max(now - S.lastT, 0.002), 0.1) : 0.016;
  S.lastT = now; S.lastDataT = now; S.has = true;

  // --- raw gyro (deg/s), x=beta, y=gamma, z=alpha ---
  S.rawW = [r.beta || 0, r.gamma || 0, r.alpha || 0];
  let w = [S.rawW[0] - S.bias[0], S.rawW[1] - S.bias[1], S.rawW[2] - S.bias[2]];
  let mag = Math.hypot(w[0], w[1], w[2]);
  if (mag < 2.5) { w = [0, 0, 0]; mag = 0; }          // dead band

  if (state === 'calibStill') cal.still.push(S.rawW.slice());

  // --- estimate the roll axis (slowly follows the dominant rotation) ---
  if (mag > 40) {
    const wn = w.map(v => v / mag);
    if (!S.axisReady) { S.axis = wn; S.axisReady = true; }
    else {
      const s = dot3(wn, S.axis) < 0 ? -1 : 1;
      const k = 1 - Math.exp(-dt / 2.5);
      S.axis = norm3(S.axis.map((a, i) => a * (1 - k) + s * wn[i] * k));
    }
  }

  // --- rotation around the roll axis (signed) ---
  const wAxis = dot3(w, S.axis);
  S.wAxisS += (wAxis - S.wAxisS) * (1 - Math.exp(-dt / 0.06));
  const sp = Math.abs(S.wAxisS);
  S.speedFast += (sp - S.speedFast) * (1 - Math.exp(-dt / 0.3));
  S.speedSlow += (sp - S.speedSlow) * (1 - Math.exp(-dt / 1.5));

  // --- axis purity: |rotation about axis| / |total rotation| ---
  S.pNum += (Math.abs(wAxis) - S.pNum) * (1 - Math.exp(-dt / 0.6));
  S.pDen += (mag - S.pDen) * (1 - Math.exp(-dt / 0.6));

  // --- jerk (normalised by speed) ---
  const dW = (S.wAxisS - S.lastWAxis) / dt; S.lastWAxis = S.wAxisS;
  S.jerk += (Math.abs(dW) / Math.max(S.speedSlow, 30) - S.jerk) * (1 - Math.exp(-dt / 0.4));

  // --- direction reversal ---
  if (sp > 25) {
    const sg = Math.sign(S.wAxisS);
    if (S.dirSign !== 0 && sg !== S.dirSign) { S.reversalT = now; resetRev(now); }
    S.dirSign = sg;
  }

  // --- impact: high-passed linear acceleration (bumps, grabs, hand-offs) ---
  const lin = (e.acceleration && e.acceleration.x != null) ? e.acceleration
            : e.accelerationIncludingGravity;
  if (lin && lin.x != null) {
    const l = [lin.x, lin.y, lin.z];
    const tau = (e.acceleration && e.acceleration.x != null) ? 0.35 : 0.15;
    const a = 1 - Math.exp(-dt / tau);
    for (let i = 0; i < 3; i++) S.linLP[i] += (l[i] - S.linLP[i]) * a;
    const hp = Math.hypot(l[0] - S.linLP[0], l[1] - S.linLP[1], l[2] - S.linLP[2]);
    S.impact = Math.max(S.impact * Math.exp(-dt / 0.6), hp);
  }

  // --- angle integration + revolution bookkeeping ---
  if (sp > cfg.speedFloor) S.ang += S.wAxisS * dt;
  S.revSamples.push({ a: S.ang, w: sp });
  if (S.revSamples.length > 4000) S.revSamples.shift();

  // live deviation from the previous revolution's speed profile
  if (S.prevBins && sp > cfg.speedFloor) {
    const idx = binIndex(S.ang - S.revStartAng);
    const inst = Math.abs(sp - S.prevBins[idx]) / Math.max(S.prevMean, 30);
    S.devEMA += (inst - S.devEMA) * (1 - Math.exp(-dt / 0.5));
  }

  if (Math.abs(S.ang - S.revStartAng) >= 360) finishRev(now);
  if (now - S.revStartT > 12) resetRev(now);

  // stopped for a while -> forget revolution history (keep signature)
  if (S.speedFast < 10) { S.slowT += dt; if (S.slowT > 1.5) { S.periods = []; S.lastRev = null; resetRev(now); } }
  else S.slowT = 0;
}

function decaySensors(dt) {
  const k = 1 - Math.exp(-dt / 0.3);
  S.speedFast += (0 - S.speedFast) * k;
  S.impact *= Math.exp(-dt / 0.6);
}

function binIndex(relAngle) {
  return Math.min(11, Math.floor(Math.abs(relAngle) / 30));
}

function resetRev(now) {
  S.revStartAng = S.ang; S.revStartT = now; S.revSamples = [];
}

function finishRev(now) {
  const N = 12, sum = Array(N).fill(0), cnt = Array(N).fill(0);
  for (const s of S.revSamples) {
    const i = binIndex(s.a - S.revStartAng);
    sum[i] += s.w; cnt[i]++;
  }
  const bins = sum.map((v, i) => cnt[i] ? v / cnt[i] : null);
  const valid = bins.filter(v => v !== null);
  if (valid.length < N - 2) { resetRev(now); return; }
  const avg = mean(valid);
  for (let i = 0; i < N; i++) if (bins[i] === null) bins[i] = avg;

  const period = now - S.revStartT;
  const ripple = (Math.max(...bins) - Math.min(...bins)) / Math.max(avg, 1);
  let drift = null;
  if (S.prevBins) {
    let e = 0;
    for (let i = 0; i < N; i++) e += (bins[i] - S.prevBins[i]) ** 2;
    drift = Math.sqrt(e / N) / Math.max(avg, 1);
  }
  S.periods.push(period); if (S.periods.length > 5) S.periods.shift();
  S.lastRev = { period, avg, ripple, drift, t: now };
  S.prevBins = bins; S.prevMean = avg;
  resetRev(now);
}


// Metrics + stability score

function computeMetrics(now) {
  const speed = S.speedFast;
  const purity = S.pDen > 8 ? Math.min(1, S.pNum / S.pDen) : 0;
  const lr = (S.lastRev && now - S.lastRev.t < 15) ? S.lastRev : null;
  const ripple = lr ? lr.ripple : 0;

  let revCV = 0;
  if (S.periods.length >= 3) {
    const m = mean(S.periods);
    revCV = Math.sqrt(mean(S.periods.map(p => (p - m) ** 2))) / m;
  }
  const rev = Math.max(revCV, lr && lr.drift != null ? lr.drift : 0);
  const dev = S.prevBins ? S.devEMA : Math.min(1, S.jerk * 0.25);
  const impact = S.impact;
  const dirOk = (now - S.reversalT) > 2.5;

  const sSpeed = sm(speed, cfg.speedLo * 0.6, cfg.speedLo) *
                 (1 - sm(speed, cfg.speedHi, cfg.speedHi * 1.5));
  const sPurity = sm(purity, cfg.purityMin * 0.7, cfg.purityMin);
  const sRipple = 1 - sm(ripple, cfg.rippleTol, cfg.rippleTol * 2.5);
  const sRev = 1 - sm(rev, cfg.revTol, cfg.revTol * 3);
  const sDev = 1 - sm(dev, cfg.devTol, cfg.devTol * 2.5);
  const sImpact = 1 - sm(impact, cfg.impactTol, cfg.impactTol * 2.5);
  const sDir = dirOk ? 1 : 0.3;

  const base = 0.22 * sPurity + 0.14 * sRipple + 0.14 * sRev + 0.24 * sDev + 0.26 * sImpact;
  const worst = Math.min(sPurity, sRipple, sRev, sDev, sImpact);
  const score = sSpeed * sDir * (0.75 * base + 0.25 * worst);

  return { speed, purity, ripple, rev, dev, impact, dirOk, score,
           parts: { sSpeed, sPurity, sRipple, sRev, sDev, sImpact, sDir } };
}

function updateStability(m, now) {
  if (!stable) {
    if (m.score >= cfg.enterScore) {
      if (stableSince === null) stableSince = now;
      if (now - stableSince >= cfg.enterHold) { stable = true; everStable = true; unstableSince = null; onSettled(); }
    } else stableSince = null;
  } else {
    if (m.score < cfg.exitScore) {
      if (unstableSince === null) unstableSince = now;
      if (now - unstableSince >= cfg.exitHold) { stable = false; stableSince = null; unstableSince = null; }
    } else unstableSince = null;
  }
}

function updateCry(m, now, dt) {
  let target = stable ? 0 : 1 - sm(m.score, 0.20, 0.55);
  if (!cfg.cryOnStop && m.speed < cfg.speedFloor * 2) target = Math.min(target, 0.25);
  if (now < graceUntil && !everStable) target = 0;           // grace period after calibration

  const rate = target > cry ? 0.7 : (stable ? 0.9 : 0.3);   // cries up fast-ish, calms down slower
  cry += (target - cry) * (1 - Math.exp(-rate * dt));

  // sudden bump -> instant extra fuss (with cooldown)
  if (m.impact > cfg.impactTol * 1.5 && now - lastBumpT > 0.8 && now > graceUntil) {
    cry = Math.min(1, cry + 0.25); lastBumpT = now;
  }
}

function onSettled() {
  if (cfg.vibrate && navigator.vibrate) navigator.vibrate(30); // soft "settled" tick
}

// =====================================================================
// Calibration

function beginCalibration() {
  cal = { still: [], speed: [], purity: [], ripple: [], dev: [], rev: [], impact: [] };
  state = 'calibStill'; stateT0 = performance.now() / 1000;
  stable = false; cry = 0; everStable = false;
  S.axisReady = false; S.prevBins = null; S.periods = []; S.lastRev = null;
  S.devEMA = 0; S.reversalT = -99; S.dirSign = 0;
  msg = '';
}

function runCalibStill(now) {
  const t = now - stateT0;
  if (!S.has && t > 2.5) msg = 'No motion data. Use HTTPS on a phone and allow motion access.';
  if (t > 1.5 && S.has && cal.still.length > 20) {
    S.bias = [0, 1, 2].map(i => mean(cal.still.map(v => v[i])));  // gyro bias
    state = 'calibRoll'; stateT0 = now; msg = '';
  }
}

function runCalibRoll(now) {
  const t = now - stateT0;
  if (t > 1.5) {                                      // skip the start-up transient
    if (M.speed > cfg.speedFloor * 3) {
      cal.speed.push(M.speed); cal.purity.push(M.purity);
      cal.ripple.push(M.ripple); cal.dev.push(M.dev);
      cal.rev.push(M.rev); cal.impact.push(M.impact);
    }
  }
  if (t > 9) finishCalibration(now);
}

function finishCalibration(now) {
  if (cal.speed.length < 60) {                        // not enough rolling seen
    msg = 'Not enough rolling detected. Roll steadily and try again.';
    stateT0 = now; cal.speed = []; cal.purity = []; cal.ripple = [];
    cal.dev = []; cal.rev = []; cal.impact = [];
    return;
  }
  const sp = quant(cal.speed, 0.5);
  cfg.speedLo = Math.max(12, sp * 0.35);
  cfg.speedHi = sp * 3;
  cfg.purityMin = constrain(quant(cal.purity, 0.2) * 0.7, 0.3, 0.8);
  cfg.rippleTol = Math.max(0.2, quant(cal.ripple, 0.8) * 2.5);
  cfg.devTol = Math.max(0.3, quant(cal.dev, 0.8) * 3);
  cfg.revTol = Math.max(0.15, quant(cal.rev, 0.8) * 3);
  cfg.impactTol = Math.max(4, quant(cal.impact, 0.9) * 3);

  state = 'play'; msg = '';
  graceUntil = now + 6; stable = false; stableSince = null; unstableSince = null;
}

// =====================================================================
// Audio: real baby cry soundscape (burst - inhale gap - burst ...)
// =====================================================================

let actx, cryGain, cryBuf = null, crySrc = null;
const CRY_FILE = 'baby-cry.mp3';          // put this file next to index.html
function initAudio() {
  if (actx) { actx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    cryGain = actx.createGain(); cryGain.gain.value = 0;
    cryGain.connect(actx.destination);
    actx.resume();
    audioOn = true;
    fetch(CRY_FILE).then(r => r.arrayBuffer())
      .then(buf => new Promise((ok, err) => actx.decodeAudioData(buf, ok, err)))
      .then(decoded => {
        cryBuf = decoded;
        crySrc = actx.createBufferSource();
        crySrc.buffer = cryBuf; crySrc.loop = true;     // loops forever, volume is controlled by gain
        crySrc.connect(cryGain);
        crySrc.start();
      })
      .catch(() => { msg = 'Could not load ' + CRY_FILE; });
  } catch (e) { audioOn = false; }
}

function setParam(param, value, tc) {
  param.setTargetAtTime(value, actx.currentTime, tc);
}

function updateVoice(dt) {
  // cryPhase / voiceEnv still drive the mouth animation and vibration bursts
  if (cry < 0.04) { voiceEnv = 0; cryPhase = 0; silence(); return; }
  cryPhase += dt * (0.7 + 0.9 * cry);
  if (cryPhase >= 1) { cryPhase -= 1; onBurstStart(); }
  const burstEnd = 0.72;
  voiceEnv = cryPhase < burstEnd ? Math.pow(Math.sin(Math.PI * cryPhase / burstEnd), 0.6) : 0;

  if (!audioOn || !cfg.sound || !cryGain || !crySrc) return;
  setParam(cryGain.gain, 0.9 * Math.pow(cry, 0.7), 0.08);          // louder when more upset
  setParam(crySrc.playbackRate, 0.95 + 0.15 * cry, 0.2);            // slightly faster when more upset
}

function silence() {
  if (!audioOn || !cryGain) return;
  setParam(cryGain.gain, 0, 0.1);
}

// =====================================================================
// Vibration: one pulse train per cry burst (Android Chrome only)
// =====================================================================

function onBurstStart() {
  if (!cfg.vibrate || !navigator.vibrate || state !== 'play') return;
  const on = Math.floor(40 + 120 * cry);
  const gap = Math.floor(80 - 50 * cry);
  const n = 2 + Math.floor(cry * 4);
  const p = [];
  for (let i = 0; i < n; i++) { p.push(on); if (i < n - 1) p.push(gap); }
  navigator.vibrate(p);
}

// =====================================================================
// Drawing
// =====================================================================

function drawScene() {
  const calm = color(205, 228, 255), upset = color(255, 170, 160);
  background(lerpColor(calm, upset, cry));

  if (state === 'start') { drawBaby(0, true); drawCentered('Rolling Belt\nBaby Balance', height * 0.12, 30);
    drawCentered('Tap to start\n(allow motion access)', height * 0.82, 20);
    fill(40); noStroke(); textSize(17);
    text("Please keep your screen on,\nturn up the sound to the max volume", width / 2, height * 0.68, width * 0.85);
    drawMsg(); return; }

  drawBaby(cry, stable);

  if (state === 'calibStill') {
    drawCentered('Calibrating 1/2\nKeep the belt still', height * 0.12, 24);
  } else if (state === 'calibRoll') {
    const left = Math.max(0, 9 - (performance.now() / 1000 - stateT0));
    drawCentered('Calibrating 2/2\nRoll steadily the way you will play\n' + left.toFixed(0) + ' s', height * 0.12, 22);
  } else {
    const label = stable ? 'Sleeping... keep it steady'
                : (M.speed < cfg.speedLo * 0.6 ? 'Keep it rolling!' : (cry > 0.5 ? 'Waaah!' : 'Getting fussy...'));
    drawCentered(label, height * 0.1, 26);
    drawScoreBar(M.score);
    fill(0, 90); textSize(14); text('tap bottom: recalibrate', width / 2, height * 0.93);
  }
  if (debugOn) drawDebug();
  drawMsg();
}

function drawBaby(c, calmFace) {
  push();
  translate(width / 2, height * 0.45);
  const sh = c * 6; translate(random(-sh, sh), random(-sh, sh));
  const R = Math.min(width, height) * 0.28;

  stroke(120, 80, 60); strokeWeight(3); fill(255, 224, 196);
  circle(0, 0, R * 2);
  noStroke(); fill(255, 150, 150, 120);
  circle(-R * 0.55, R * 0.15, R * 0.3); circle(R * 0.55, R * 0.15, R * 0.3);

  stroke(70, 40, 30); strokeWeight(R * 0.05); noFill();
  if (c < 0.15) {                                        // sleeping arcs
    arc(-R * 0.38, -R * 0.1, R * 0.34, R * 0.22, 0, PI);
    arc(R * 0.38, -R * 0.1, R * 0.34, R * 0.22, 0, PI);
  } else {                                               // squeezed eyes
    line(-R * 0.55, -R * 0.2, -R * 0.2, -R * 0.1 - c * R * 0.08);
    line(R * 0.55, -R * 0.2, R * 0.2, -R * 0.1 - c * R * 0.08);
  }

  fill(120, 30, 40); noStroke();                         // mouth follows the voice envelope
  const mh = R * (0.08 + 0.55 * c * (0.3 + 0.7 * voiceEnv));
  ellipse(0, R * 0.5, R * (0.3 + 0.25 * c), mh);

  if (c > 0.3) {                                         // tears
    fill(120, 180, 255, 210);
    for (let i = 0; i < 4; i++) {
      const y = (frameCount * (2 + 4 * c) + i * 37) % (R * 0.8);
      const side = i % 2 ? 1 : -1;
      ellipse(side * R * (0.38 + 0.06 * (i >> 1)), -R * 0.05 + y, R * 0.07, R * 0.12);
    }
  }
  if (c < 0.1 && calmFace) { fill(0, 70); textSize(R * 0.25); text('z z z', R * 0.9, -R * 0.8); }
  pop();
}

function drawScoreBar(score) {
  const w = width * 0.8, h = 14, x = width * 0.1, y = height * 0.82 - 30;
  noStroke(); fill(0, 40); rect(x, y, w, h, 7);
  fill(lerpColor(color(230, 80, 70), color(70, 190, 110), score)); rect(x, y, w * score, h, 7);
  stroke(0, 120); strokeWeight(2);
  line(x + w * cfg.enterScore, y - 4, x + w * cfg.enterScore, y + h + 4);
}

function drawDebug() {
  const p = M.parts;
  const lines = [
    'speed  ' + M.speed.toFixed(0) + ' deg/s  [' + cfg.speedLo.toFixed(0) + '-' + cfg.speedHi.toFixed(0) + ']',
    'purity ' + M.purity.toFixed(2) + '  min ' + cfg.purityMin.toFixed(2),
    'ripple ' + M.ripple.toFixed(2) + '  tol ' + cfg.rippleTol.toFixed(2),
    'rev    ' + M.rev.toFixed(2) + '  tol ' + cfg.revTol.toFixed(2),
    'dev    ' + M.dev.toFixed(2) + '  tol ' + cfg.devTol.toFixed(2),
    'impact ' + M.impact.toFixed(1) + '  tol ' + cfg.impactTol.toFixed(1),
    'score  ' + M.score.toFixed(2) + '  cry ' + cry.toFixed(2),
    'parts  ' + [p.sSpeed, p.sPurity, p.sRipple, p.sRev, p.sDev, p.sImpact].map(v => v.toFixed(1)).join(' ')
  ];
  push(); textAlign(LEFT, TOP); textSize(11); fill(0, 160); noStroke();
  text(lines.join('\n'), 8, 8);
  pop();
}

function drawCentered(s, y, size) {
  fill(40); noStroke(); textSize(size); text(s, width / 2, y);
}
function drawMsg() { if (msg) { fill(160, 30, 30); textSize(15); text(msg, width / 2, height * 0.72, width * 0.9); } }

// =====================================================================
// Small helpers
// =====================================================================
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(a) { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; }
function mean(a) { return a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0; }
function sm(x, a, b) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function quant(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
// =====================================================================
// Keep the screen on (needs a tap, https, not the p5 web editor)
// Uses p5-phone's keepScreenOn() if the version has it (1.16.0+),
// otherwise falls back to the browser's own wake lock.
// =====================================================================
let wakeLock = null;

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); }
  catch (err) { console.log('Wake lock refused: ' + err.message); }
}

function mouseReleased() {
  if (typeof keepScreenOn === 'function') {
    if (!window.screenAwake) keepScreenOn();
  } else if (navigator.wakeLock && (wakeLock === null || wakeLock.released)) {
    requestWakeLock();
  }
}

// the phone drops the lock when you switch apps: ask again when you come back
document.addEventListener('visibilitychange', () => {
  if (typeof keepScreenOn !== 'function' && wakeLock !== null && document.visibilityState === 'visible') {
    requestWakeLock();
  }
});