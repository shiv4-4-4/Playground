// Swing and barbell code - Using Acceleration and normalizing it to estimate lift.

const rope_l = 0.6; //fix for rope (in m)
const swing_axis = 'x';

const invert_up = false;
const leak = 0.995;
const cry_wait = 1;
const too_still = 0.021;

let up = { x: 0, y: 0, z: 1 };
let upRest = null;
let swing_angle = 0; // in radians NOT degrees
let vel = 0; // in m/s (wtf is a kilometer)
let liftH = 0;
let bias = 0;
let lastT = 0;
let gLP = null;
let gotData = false;
let sensorBirth = 0;

let cryvid;
let prev = null; // where the phone was last frame
let dotMove = 0;
let lastMoved = 0;
let crying = false;

// instructional video, plays before the first calibration tap
let preVid;
let preStarted = false;

function setup() {
  createCanvas(windowWidth, windowHeight);
  lockGestures();

  if (location.protocol === 'https:' || location.protocol === 'blob:') {
    showDesktopQr();
  }

  enablePermissionsTap(['motion'], 'Tap to start');

  window.addEventListener('devicemotion', onMotion);

  cryvid = createVideo('cryVidd.mp4');
  cryvid.hide();
  cryvid.elt.setAttribute('playsinline', '');

  preVid = createVideo('1xal.mp4');
  preVid.hide();
  preVid.elt.setAttribute('playsinline', '');
}

function mousePressed() {
  if (window.sensorsEnabled && millis() - sensorBirth > 500) {
    calibrate();
    cryvid.play();
    cryvid.pause();
  }
}

function calibrate() {
  upRest = { x: up.x, y: up.y, z: up.z };
  vel = 0;
  liftH = 0;
  bias = 0;
  prev = null;
  lastMoved = millis();
  dotMove = 0;

  // instructions are done, stop the video
  preVid.pause();
}

// loops the instructional video until the first tap
function startPreSwing() {
  preStarted = true;
  preVid.elt.loop = true;
  // if the browser blocks playback with sound, play it muted instead
  preVid.elt.play().catch(() => {
    preVid.elt.muted = true;
    preVid.elt.play();
  });
}

function onMotion(e) {
  let awg = e.accelerationIncludingGravity;
  if (!awg || awg.x === null) return;
  gotData = true;

  let t = e.timeStamp / 1000;
  let dt = lastT ? t - lastT : 0;
  lastT = t;
  if (dt <= 0 || dt > 0.1) return;

  // Finding gravity (starring sandra)
  let grav;
  let lin;
  let a = e.acceleration;
  if (a && a.x !== null) {
    grav = { x: awg.x - a.x, y: awg.y - a.y, z: awg.z - a.z };
    lin = a;
  } else {
   // older phones calibration
    if (!gLP) gLP = { ...awg };
    gLP.x += (awg.x - gLP.x) * 0.05;
    gLP.y += (awg.y - gLP.y) * 0.05;
    gLP.z += (awg.z - gLP.z) * 0.05;
    grav = gLP;
    lin = { x: awg.x - gLP.x, y: awg.y - gLP.y, z: awg.z - gLP.z };
  
  }

  // Finding the unit gravity vector
  let gm = Math.hypot(grav.x, grav.y, grav.z) || 1;
  up = { x: grav.x / gm, y: grav.y / gm, z: grav.z / gm };

  // Lyft : how up or how down
  let aV = lin.x * up.x + lin.y * up.y + lin.z * up.z; // accelerationVector: aV
  if (invert_up) aV = -aV;

  
  bias += (aV - bias) * 0.005;
  aV -= bias;
  

  vel = (vel + aV * dt) * leak;
  liftH = (liftH + vel * dt) * leak;

  // Swing
  if (upRest) {
    let curve = swing_axis === 'x' ? Math.atan2(up.y, up.z) : Math.atan2(up.x, up.z);
    let rest = swing_axis === 'x' ? Math.atan2(upRest.y, upRest.z) : Math.atan2(upRest.x, upRest.z);
    let d = curve - rest; // Change in angle
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    swing_angle = d;
  }
}

function draw() {
  background(20);

  if (window.sensorsEnabled && sensorBirth === 0) {
    sensorBirth = millis();
  }

  if (!upRest) {
    // before calibration: show the instructional video
    if (window.sensorsEnabled) {
      if (!preStarted) startPreSwing();
      image(preVid, 0, 0, width, height);
    }
  } else {
    // forward/back distance from the swing angle
    let sx = rope_l * Math.sin(swing_angle);
    if (prev) {
      let step = dist(prev.x, prev.h, sx, liftH);
      dotMove = lerp(dotMove, step, 0.1);
    }
    prev = { x: sx, h: liftH };

    if (dotMove > too_still) {
      lastMoved = millis();
    }
    let canCry = millis() - lastMoved > cry_wait * 1000;
    if (canCry !== crying) {
      crying = canCry;
      if (crying) {
        cryvid.loop();
      } else {
        cryvid.pause();
      }
    }

    if (crying) {
      image(cryvid, 0, 0, width, height);
    }
  }

  let note = sensorNote();
  if (note) drawNote(note);
}

// only shows up when something's wrong
function sensorNote() {
  if (!window.sensorsEnabled) {
    return 'Tap to start. The sensors need a phone.';
  }
  if (!gotData && millis() - sensorBirth > 1500) {
    return 'No motion readings yet. Open the page from an https link, not an embedded preview.';
  }
  return '';
}

function drawNote(note) {
  noStroke();
  fill(0, 180);
  rect(0, 0, width, 80);
  fill(255, 200, 0);
  textSize(16);
  textAlign(LEFT, TOP);
  text(note, 16, 14, width - 32);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}