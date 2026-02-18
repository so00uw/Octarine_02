(() => {
  const SCREENS = ["start", "consent", "scan", "analyze", "result"];

  const els = {
    topbar: document.getElementById("topbar"),
    bgVideo: document.getElementById("bgVideo"),
    btnStart: document.getElementById("btnStart"),
    btnToScan: document.getElementById("btnToScan"),
    btnRestart: document.getElementById("btnRestart"),
    btnRestartFinal: document.getElementById("btnRestartFinal"),
    consentChecks: Array.from(document.querySelectorAll("input.consent")),
    stepIcons: {
      consent: document.getElementById("step-consent"),
      scan: document.getElementById("step-scan"),
      analyze: document.getElementById("step-analyze"),
      result: document.getElementById("step-result"),
    },
    screens: Object.fromEntries(
      SCREENS.map((k) => [k, document.querySelector(`[data-screen="${k}"]`)])
    ),
  };

  // ---- Step icon opacity rules ----
  // One icon is darker by original image -> we give it 0.5, others 0.4
  // (We don't auto-detect darkness; we hard-assign to "result" as the 0.5 one by default.
  //  If your darker asset is different, change DARK_ICON_KEY.)
  const DARK_ICON_KEY = "result";
  const DIM = 0.40;
  const DIM_DARK = 0.50;

  // ---- Projection window reuse ----
  const PROJECTION_NAME = "EXHIBITION_PROJECTION";
  let projectionWin = null;

  function ensureProjectionWindow() {
    // Try reuse existing named window
    try {
      projectionWin = window.open("projection.html", PROJECTION_NAME, "width=320,height=180,left=20,top=20");
    } catch (e) {
      projectionWin = null;
    }
    // If blocked, we will open it on user gesture (Start click) as fallback.
    return projectionWin;
  }

  function postToProjection(type, payload = {}) {
    if (!projectionWin || projectionWin.closed) return;
    projectionWin.postMessage({ type, payload }, "*");
  }

  // ---- SPA navigation ----
  function setScreen(next) {
    if (!SCREENS.includes(next)) return;

    for (const k of SCREENS) {
      els.screens[k].classList.toggle("is-active", k === next);
    }

    // Start screen: topbar still exists but you wanted icons from consent step
    // We'll keep topbar visible always, but dim icons appropriately.
    updateStepIcons(next);

    document.body.dataset.screen = next;
    // 새로 추가한 6단계 시퀀스 제어 함수 호출
    showScreen(next);
    

    // When entering start, try ensure projection window (won't reopen multiple tabs because name fixed)
    if (next === "start") {
      resetConsent();
      ensureProjectionWindow();
      postToProjection("CLEAR"); // keep black
    }
    // scan 화면 들어가면 카메라 시작, 나가면 중지
if (next === "scan") startScan();
else stopScan();

if (next === "analyze") startAnalyze();
else stopAnalyze();

if(next==="result") renderResult();


  }

  function updateStepIcons(screen) {
    // Icons should be meaningful from consent to result. On start, keep them dim.
    const activeKey =
      screen === "consent" ? "consent" :
      screen === "scan" ? "scan" :
      screen === "analyze" ? "analyze" :
      screen === "result" ? "result" : null;

    for (const [key, img] of Object.entries(els.stepIcons)) {
      if (!img) continue;
      if (activeKey === key) {
        img.style.opacity = "1";
      } else {
        img.style.opacity = (key === DARK_ICON_KEY ? String(DIM_DARK) : String(DIM));
      }
    }
  }

  // ---- Consent button enable ----
  function updateConsentButton() {
    const ok = els.consentChecks.every((c) => c.checked);
    els.btnToScan.disabled = !ok;
  }
  function resetConsent() {
  els.consentChecks.forEach(c => (c.checked = false));
  updateConsentButton(); // 버튼 disabled 상태도 같이 갱신
}

// =========================
// Scan (Camera + FaceMesh) lifecycle
// =========================
let scanStarted = false;
let faceMesh = null;
let camera = null;
let lastLandmarks = null;
let stableFrames = 0;
let capturedImageDataUrl = null;
let capturedLandmarks = null;


const SCAN = {
  camW: 805,
  camH: 672,
  snapW: 1600,
  snapH: 1336,
  stableNeed: 10,
  // guide frame (absolute on page) -> camera-box relative
  guideAbs: { left: 815, top: 351, width: 289, height: 301 },
  camAbs: { left: 558, top: 191 }
};

function getScanEls() {
  return {
    video: document.getElementById("video"),
    overlay: document.getElementById("overlay"),
    hint: document.getElementById("scanHint"),
    btn: document.getElementById("btnCapture")
  };
}

function setCaptureState(active, msg) {
  const { btn, hint } = getScanEls();
  if (!btn || !hint) return;

  if (active) {
    btn.disabled = false;
    btn.classList.add("active");
    hint.textContent = "촬영 가능";
  } else {
    btn.disabled = true;
    btn.classList.remove("active");
    hint.textContent = msg || "얼굴을 네모 안에 맞춰줘";
  }
}

async function startScan() {
  if (scanStarted) return;
  scanStarted = true;

  const { video, overlay, btn } = getScanEls();
  if (!video || !overlay || !btn) {
    console.error("[SCAN] elements missing. Check screen-scan HTML.");
    return;
  }

  // overlay는 고정 크기(시안 기준)로 쓰는 게 안정적
  overlay.width = SCAN.camW;
  overlay.height = SCAN.camH;

  stableFrames = 0;
  lastLandmarks = null;
  setCaptureState(false, "얼굴을 네모 안에 맞춰줘");

  // FaceMesh init (once)
  if (!faceMesh) {
    faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    faceMesh.onResults(onFaceResults);
  }

  // Camera init (once)
  if (!camera) {
    camera = new Camera(video, {
      onFrame: async () => {
        await faceMesh.send({ image: video });
      },
      width: SCAN.camW,
      height: SCAN.camH
    });
  }

  try {
    await camera.start();
  } catch (e) {
    console.error("[SCAN] camera start failed:", e);
    setCaptureState(false, "카메라 권한을 허용해줘");
  }

  // capture click (중복 바인딩 방지)
  if (!btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      if (!lastLandmarks) return;

      // 스냅샷(저장 X, 메모리용 DataURL)
      const temp = document.createElement("canvas");
      temp.width = SCAN.snapW;
      temp.height = SCAN.snapH;
      const tctx = temp.getContext("2d");
      tctx.drawImage(video, 0, 0, SCAN.snapW, SCAN.snapH);
capturedLandmarks = (window.structuredClone)
  ? structuredClone(lastLandmarks)
  : JSON.parse(JSON.stringify(lastLandmarks));

      capturedImageDataUrl = temp.toDataURL("image/png");
      // 다음 스텝에서 analyze/result에 이 이미지를 쓸 거야.
      setScreen("analyze");
    });
  }
}

function stopScan() {
  // MediaPipe Camera는 stop()이 버전에 따라 없을 수 있어.
  // 그래서 "scanStarted"만 내리고, onResults가 더 와도 무시하도록 처리.
  scanStarted = false;
  stableFrames = 0;
  lastLandmarks = null;
  setCaptureState(false, "");
}

function onFaceResults(results) {
  if (!scanStarted) return;

  const { overlay } = getScanEls();
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const faces = results.multiFaceLandmarks || [];
  if (faces.length === 0) {
    stableFrames = 0;
    setCaptureState(false, "얼굴을 인식하지 못함");
    return;
  }

  const lm = faces[0];
  lastLandmarks = lm;

  // 얼굴 위치 및 크기 계산 (이 계산이 아래 로직보다 먼저 와야 합니다)
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const faceW = (maxX - minX) * SCAN.camW;
  const cx = ((minX + maxX) / 2) * SCAN.camW;
  const cy = ((minY + maxY) / 2) * SCAN.camH;

  const guide = {
    left: SCAN.guideAbs.left - SCAN.camAbs.left,
    top: SCAN.guideAbs.top - SCAN.camAbs.top,
    width: SCAN.guideAbs.width,
    height: SCAN.guideAbs.height
  };

  const inside =
    cx > guide.left &&
    cx < guide.left + guide.width &&
    cy > guide.top &&
    cy < guide.top + guide.height;

  const tooSmall = faceW < guide.width * 0.40;
  const tooBig = faceW > guide.width * 0.75;
  const sizeOK = !tooSmall && !tooBig;

  // --- [수정된 자동 촬영 및 좌표 전송 로직] ---
  if (inside && sizeOK) {
    stableFrames++;
  } else {
    stableFrames = 0;
  }

  // 약 3~4초 유지 (100프레임 기준)
  if (stableFrames >= 100) { 
    const { video } = getScanEls();
    const temp = document.createElement("canvas");
    temp.width = SCAN.snapW;
    temp.height = SCAN.snapH;
    const tctx = temp.getContext("2d");
    tctx.drawImage(video, 0, 0, SCAN.snapW, SCAN.snapH);
    
    capturedImageDataUrl = temp.toDataURL("image/png");
    capturedLandmarks = JSON.parse(JSON.stringify(lastLandmarks));

    // 프로젝션 창에 촬영 이미지 전송
    postToProjection("SHOW_RESULT_FRAME", { 
        image: capturedImageDataUrl,
        landmarks: capturedLandmarks 
    });
    stableFrames = 0;
    setScreen("analyze");
  } else {
    // 실시간 좌표만 전송 (에러 방지를 위해 비디오 객체 제외)
    postToProjection("UPDATE_FACE", { landmarks: lm });
    
    // UI 힌트 업데이트
    if (!inside) setCaptureState(false, "얼굴을 네모 안에 맞추십시오");
    else if (tooSmall) setCaptureState(false, "가까이 오십시오");
    else if (tooBig) setCaptureState(false, "멀어져라");
    else setCaptureState(false, `분석 중... 잠시만 고정 (${Math.floor(stableFrames/25)}s)`);
  }
}// =========================
// Analyze (5s scan line + logs) lifecycle
// =========================
let analyzeTimer = null;
let analyzeRAF = null;

function getAnalyzeEls(){
  return {
    photo: document.getElementById("analyzePhoto"),
    line: document.getElementById("scanLine"),
    clean: document.getElementById("logClean"),
    integ: document.getElementById("logInteg"),
    diagn: document.getElementById("logDiagn"),
  };
}

function makeLogLine(){
  // 읽히는 게 목적이 아니라 "시스템 느낌"이 목표
  const tokens = [
    "0x" + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,"0"),
    Math.random().toString(16).slice(2, 10),
    "IDX:" + Math.floor(Math.random()*9999).toString().padStart(4,"0"),
    "Z=" + (Math.random()*4-2).toFixed(3),
    "Δ=" + (Math.random()*1.2).toFixed(4),
    "RMS=" + (Math.random()*0.9).toFixed(4),
    "N=" + (200 + Math.floor(Math.random()*800)),
  ];
  const pick = [];
  const n = 3 + Math.floor(Math.random()*3);
  for(let i=0;i<n;i++){
    pick.push(tokens[Math.floor(Math.random()*tokens.length)]);
  }
  return pick.join("  ");
}

function fillLogStream(el, linesCount){
  if(!el) return;
  const lines = [];
  for(let i=0;i<linesCount;i++){
    lines.push(makeLogLine());
  }
  el.textContent = lines.join("\n");
}

// [수정] startAnalyze 함수 내부
function startAnalyze() {
    const { photo, line, clean, integ, diagn } = getAnalyzeEls();
    if (!capturedImageDataUrl) { setScreen("start"); return; }

    photo.src = capturedImageDataUrl;

    photo.style.display = "block";
    line.style.display = "block";
    line.style.animation = "scanMove 3s linear infinite";
    
    // 1. 오른쪽 영역 (기존 폭포수 애니메이션 적용)
    fillLogStream(diagn, 220); 

    // 2. 왼쪽 영역 (새로 받은 한 줄씩 추가되는 텍스트 로직 적용)
    const leftLogs = ["데이터 전송 중...", "알고리즘 분석 중...", "유전자 맵핑 중...", "결과 생성 완료"];
    let logIdx = 0;
    const logInterval = setInterval(() => {
        if (logIdx < leftLogs.length) {
            const lineA = document.createElement('div');
            const lineB = document.createElement('div');
            lineA.innerText = `> ${leftLogs[logIdx]}`;
            lineB.innerText = `> SYSTEM_CHECK: ${Math.random().toString(16).slice(2, 8)}`;
            clean.appendChild(lineA); // 왼쪽 상단
            integ.appendChild(lineB); // 왼쪽 하단
            logIdx++;
        } else {
            clearInterval(logInterval);
        }
    }, 800);

    // [중요] 기존의 5초 강제 전환 setTimeout은 삭제하거나 주석 처리하세요.
    // 대신 로직이 끝나는 시점에 결과로 넘깁니다.
    setTimeout(() => {
        setScreen("result");
    }, 5000);
}
function stopAnalyze(){
  const { line } = getAnalyzeEls();

  if (analyzeTimer) {
    clearTimeout(analyzeTimer);
    analyzeTimer = null;
  }
  if (analyzeRAF) {
    cancelAnimationFrame(analyzeRAF);
    analyzeRAF = null;
  }
  if (line) {
    line.style.display = "none";
    line.style.transition = "none";
    line.style.transform = "translateY(-10px)";
  }
}
// ---평균 얼굴 데이터 로드 ---
let averageFace = null;

async function loadAverageFace(){
  const res = await fetch("assets/data/average_face.json");
  averageFace = await res.json();
}
loadAverageFace();
// ---지능 계산 ---
function calcIntelligence(landmarks){
if(!landmarks) {
  return {
    grade:"보통",
    score:0.5,
    details:[
      `상정 비율 ........ 0.50`,
      `미간 폭 .......... 0.50`,
      `안구 개방도 ...... 0.50`,
      `대칭성 ............ 0.50`,
      `종합 지표 ........ 0.50`
    ]
  };
}

  // 대칭성 계산
  let asym = 0;
  for(let i=0;i<landmarks.length;i++){
    const p = landmarks[i];
    const mirror = landmarks[landmarks.length-1-i];
    asym += Math.abs(p.x - (1-mirror.x));
  }
  asym /= landmarks.length;

  const symmetry = 1 - asym;

  const eyeOpen = Math.random()*0.5 + 0.5; // 연출용
  const forehead = Math.random()*0.5 + 0.5;
  const glabella = Math.random()*0.5 + 0.5;

  const score = (symmetry + eyeOpen + forehead + glabella)/4;

  let grade="보통";
  if(score>0.85) grade="천재";
  else if(score>0.7) grade="우수";
  else if(score<0.45) grade="평균 이하";

  return {
    grade,
    score,
    details:[
      `상정 비율  . . . . . . . . . . . .   ${forehead.toFixed(2)}`,
      `미간 폭  . . . . . . . . . . . . .   ${glabella.toFixed(2)}`,
      `안구 개방도  . . . . . . . . . .   ${eyeOpen.toFixed(2)}`,
      `대칭성  . . . . . . . . . . . . . . . .   ${symmetry.toFixed(2)}`,
      `종합 지표  . . . . . . . . . . . .   ${score.toFixed(2)}`
    ]
  };
}
// ---범죄 점수 계산 ---
function calcCrime(intelScore){
  const types=[
    "살인범","절도범","성범죄자",
    "강도","사기/위조범","방화범"
  ];

  const scores={};

  types.forEach(t=>{
    let base=Math.random()*0.7;
    scores[t]=base;
  });

  // 지능 연동
  scores["방화범"] += (1-intelScore)*0.4;
  scores["사기/위조범"] += intelScore*0.4;

  // 정규화 0~100
  Object.keys(scores).forEach(k=>{
    scores[k]=Math.round(Math.min(1,scores[k])*100);
  });

  return scores;
}
/*** [ADD: 5단계 - 우생학 분석 알고리즘] */
function runEugenicsAnalysis(landmarks) {
    // 미간 거리 (landmark 133, 362) / 얼굴 가로폭 (landmark 234, 454)
    const eyeDistance = Math.hypot(landmarks[362].x - landmarks[133].x, landmarks[362].y - landmarks[133].y);
    const faceWidth = Math.hypot(landmarks[454].x - landmarks[234].x, landmarks[454].y - landmarks[234].y);
    
    const ratio = eyeDistance / faceWidth;
    let result = {
        grade: "B",
        tendency: "일반적 성향",
        score: Math.floor(ratio * 100)
    };

    // 가상의 '운명 판독' 로직
    if (ratio > 0.15) {
        result.grade = "S";
        result.tendency = "잠재적 유죄 성향 (주의)";
    } else if (ratio < 0.12) {
        result.grade = "A";
        result.tendency = "순응적 시민 성향";
    }

    return result;
}
/** [END: 5단계] **/

// ---렌더링 함수 ---
function renderResult(){
  const photo=document.getElementById("resultPhoto");
  photo.src=capturedImageDataUrl;

const intel=calcIntelligence(capturedLandmarks);
  const crimes=calcCrime(intel.score);

  document.getElementById("intelGrade").textContent=intel.grade;
  document.getElementById("intelDetails").innerHTML=
    intel.details.map(d=>`<div>${d}</div>`).join("");

  const crimeList=document.getElementById("crimeScores");
  crimeList.innerHTML="";
  Object.entries(crimes).forEach(([k,v])=>{
    crimeList.innerHTML+=`<div>${k} . . . . . . . . . . . . ${v}점</div>`;
  });

  const top=Object.entries(crimes)
    .sort((a,b)=>b[1]-a[1])[0];

  document.getElementById("crimeTop").textContent=
    `범죄 유형: ${top[0]}`;

  // 프로젝터 창으로 얼굴+프레임만 전송
  postToProjection("SHOW_RESULT_FRAME",{
    image: capturedImageDataUrl,
    landmarks: capturedLandmarks 
  });
}

/**
 * [ADD: 6단계 - 인터랙션 시퀀스 제어]
 */
const screens = document.querySelectorAll('.screen');

function showScreen(screenId) {
    screens.forEach(s => s.classList.remove('is-active'));
    document.getElementById(`screen-${screenId}`).classList.add('is-active');
    
    // 시퀀스별 자동 동작
    if (screenId === 'scan') {
        startTrackingSequence();
    } else if (screenId === 'analyze') {
        startProcessingSequence();
    }
}

// 6-1. Tracking: 얼굴 인식 및 데이터 수집 (5초 대기)
function startTrackingSequence() {
    console.log("Tracking 시작...");
    document.getElementById('scanHint').innerText = "데이터 추출 중... 정면을 유지하세요.";
    
}

// 6-2. Processing: 분석 애니메이션 연출
function startProcessingSequence() {
    const logs = ["데이터 전송 중...", "알고리즘 분석 중...", "유전자 맵핑 중...", "결과 생성 완료"];
    let logIdx = 0;
    
    const interval = setInterval(() => {
        if (logIdx < logs.length) {
            const logEl = document.createElement('div');
            logEl.innerText = `> ${logs[logIdx]}`;
            document.getElementById('logClean').appendChild(logEl);
            logIdx++;
        } else {
            clearInterval(interval);
            setTimeout(() => showScreen('result'), 2000); // 분석 완료 후 결과창으로
        }
    }, 1000);
}
/** [END: 6단계] **/

  // ---- Video cover/contain toggle support (for later) ----
  function setVideoFit(mode /* "cover" | "contain" */) {
    if (!els.bgVideo) return;
    els.bgVideo.style.objectFit = mode;
  }
  // Default cover
  setVideoFit("cover");

  // ---- Events ----
  // Try open projection on load (may be blocked by popup policy)
  ensureProjectionWindow();

  els.btnStart.addEventListener("click", () => {
    // If popup blocked earlier, user gesture will allow it now.
    if (!projectionWin || projectionWin.closed) ensureProjectionWindow();
    setScreen("consent");
  });

  els.consentChecks.forEach((c) => c.addEventListener("change", updateConsentButton));
  updateConsentButton();

  els.btnToScan.addEventListener("click", () => setScreen("scan"));

  els.btnRestart?.addEventListener("click", () => setScreen("start"));

  // ✅ Result 화면 '다시하기' 버튼
els.btnRestartFinal?.addEventListener("click", () => {
  // analyze/scan 동작 정리(있으면 정리, 없으면 무시)
  try { stopAnalyze(); } catch(e) {}
  try { stopScan(); } catch(e) {}

  // 촬영 데이터 리셋
  capturedImageDataUrl = null;

  // start로 이동 (start에서 resetConsent()도 호출되게 해둔 상태)
  setScreen("start");
});

  // Keep safe if projection window is reloaded: re-clear
  window.addEventListener("focus", () => postToProjection("PING"));
  
// ---- 브라우저 창 크기에 맞춰 전체 화면 스케일링 ----
  function resizeApp() {
    const wrapper = document.getElementById('scale-wrapper');
    if (!wrapper) return;

    const windowRatio = window.innerWidth / window.innerHeight;
    const standardRatio = 1920 / 1080;
    let scale = 1;

    // 창 비율에 맞춰 가로/세로 중 꽉 차는 쪽을 기준으로 스케일 계산
    if (windowRatio > standardRatio) {
      scale = window.innerHeight / 1080;
    } else {
      scale = window.innerWidth / 1920;
    }

    // [핵심 해결] translate(-50%, -50%)를 함께 적용하여 무조건 정중앙에 고정
    wrapper.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
  const logoBtn = document.getElementById('invisibleLogoBtn'); 
  const infoModal = document.getElementById('infoModal');
  const infoDim = document.querySelector('.info-dim');

  if (logoBtn && infoModal && infoDim) {
    // 버튼 클릭 시 팝업 열기
    logoBtn.addEventListener('click', () => {
      infoModal.classList.remove('hidden');
    });

    // 검은 배경 클릭 시 팝업 닫기
    infoDim.addEventListener('click', () => {
      infoModal.classList.add('hidden');
    });
  }

  window.addEventListener('resize', resizeApp);
  resizeApp(); // 시작할 때 한 번 실행
  // -----------------------------------------------------------
  // Start at start screen
  setScreen("start");
})();