// SPIRAL — Playground 1 (v2)

const CONFIG = {
  calmSeconds: 2,        // how long calm before lullaby
  calmWhenMoving: true,  // true = lullaby when spinning AND level; false = still AND level
  minSpinDegPerSec: 15,  // spin > than this "in motion"
  maxTiltDeg: 7,        // tilt < than this "level"
  graceMs: 400,          // wobbles shorter than this r ignored
};

let cry, lullaby;
let startButton;
let started = false;
let startedAt = 0;
let statusMsg = "";
let gotSensor = false;
let lastAlpha = null;
let spinSpeed = 0;
let tiltX = 0, tiltY = 0;
let okSince = null;
let badSince = null;
let calm = false;
let phase = 0;

// QR code so phones can open the sketch from a computer screen
const SHARE_URL = "https://editor.p5js.org/Mikiki/full/uLtzO9i5y";

function showDesktopQr() {
  if (typeof QRCode === "undefined") return;             // library doesn't load
  if (navigator.maxTouchPoints > 0 || windowWidth < 700) return; // phones: skip

  const box = createDiv("");
  box.position(20, 20);
  box.style("background", "white");
  box.style("padding", "12px");
  box.style("border-radius", "8px");
  box.style("text-align", "center");
  box.style("font-family", "sans-serif");
  box.style("font-size", "13px");
  new QRCode(box.elt, { text: SHARE_URL, width: 160, height: 160 });
  createP("Scan with your phone").parent(box).style("margin", "8px 0 0");
}
function preload() {
  cry = loadSound("baby-cry.mp3");
  lullaby = loadSound("carnival-lullaby.mp3");
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  angleMode(DEGREES);
  textAlign(CENTER, CENTER);

  // A button
  startButton = createButton("TAP TO START");
  startButton.style("font-size", "28px");
  startButton.style("padding", "20px 36px");
  startButton.style("border", "none");
  startButton.style("border-radius", "12px");
  startButton.style("background", "#eb3c3c");
  startButton.style("color", "white");
  placeButton();
  startButton.elt.addEventListener("click", startInstallation);
    showDesktopQr();
}

function placeButton() {
  startButton.position(width / 2 - 120, height / 2 - 40);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (!started) placeButton();
}

function startInstallation() {
  if (started) return;

  // Ask for motion access FIRST, inside the tap
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then(r => { if (r !== "granted") statusMsg = "Motion access was denied. Reload the page and allow it."; })
      .catch(e => { statusMsg = "Motion permission problem: " + e; });
  }

  userStartAudio();
  cry.loop();
  started = true;
  startedAt = millis();
  startButton.hide();
}

function draw() {
  background(15);
  if (!started) {
    fill(255);
    textSize(16);
    text("Spiral", width / 2, height / 2 - 90);
    return;
  }

  readSensors();
  interpret();
  updateSound();
  drawSpiral();
  drawReadout();
}

function readSensors() {
  if (rotationX !== 0 || rotationY !== 0) gotSensor = true;

  if (lastAlpha !== null && deltaTime > 0) {
    let d = ((rotationZ - lastAlpha + 540) % 360) - 180;
    let perSec = abs(d) / (deltaTime / 1000);
    spinSpeed = lerp(spinSpeed, perSec, 0.2);
  }
  lastAlpha = rotationZ;

  tiltX = rotationX;
  tiltY = rotationY;
}

function interpret() {
  const moving = spinSpeed > CONFIG.minSpinDegPerSec;
  const level = abs(tiltX) < CONFIG.maxTiltDeg && abs(tiltY) < CONFIG.maxTiltDeg;
  const ok = level && (CONFIG.calmWhenMoving ? moving : !moving);

  if (ok) {
    badSince = null;
    if (okSince === null) okSince = millis();
    if (millis() - okSince >= CONFIG.calmSeconds * 1000) calm = true;
  } else {
    if (badSince === null) badSince = millis();
    if (millis() - badSince > CONFIG.graceMs) {
      okSince = null;
      calm = false;
    }
  }
}

function updateSound() {
  if (calm) {
    if (!lullaby.isPlaying()) { cry.stop(); lullaby.loop(); }
  } else {
    if (!cry.isPlaying()) { lullaby.stop(); cry.loop(); }
  }
}

function drawSpiral() {
  if (calm) phase += 1 + spinSpeed * 0.03;
  const col = calm ? color(60, 220, 120) : color(235, 60, 60);

  push();
  translate(width / 2, height / 2.2);
  rotate(phase);
  noFill();
  stroke(col);
  strokeWeight(4);
  const maxR = min(width, height) * 0.38;
  beginShape();
  for (let a = 0; a < 1080; a += 6) {
    const r = map(a, 0, 1080, 4, maxR);
    vertex(r * cos(a), r * sin(a));
  }
  endShape();
  pop();
}

function drawReadout() {
  fill(255);
  noStroke();
  textSize(18);
  text(calm ? "Calm — the baby is soothed" : "The baby is crying", width / 2, height * 0.80);

  textSize(14);
  const hold = okSince ? nf(min((millis() - okSince) / 1000, CONFIG.calmSeconds), 1, 1) : "0.0";
  text("spin " + round(spinSpeed) + "°/s   tilt X " + round(tiltX) + "°   tilt Y " + round(tiltY) + "°",
       width / 2, height * 0.86);
  text("hold " + hold + " / " + CONFIG.calmSeconds + " s", width / 2, height * 0.90);

  // Helpful messages for phones, where you can't see the console
  fill(255, 200, 80);
  if (statusMsg) text(statusMsg, width / 2, height * 0.94);
  else if (!gotSensor && millis() - startedAt > 3000)
    text("No motion data yet. Check the motion permission.", width / 2, height * 0.94);
}