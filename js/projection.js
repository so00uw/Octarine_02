(() => {
  const stage = document.getElementById("stage");

  // =========================================
  // [1] 설정값 관리 (자동 저장 불러오기)
  // =========================================
  const DEFAULT_SETTINGS = {
      x: 0, y: 0,          // 위치
      scale: 1.0,          // 전체 크기
      scaleY: 0.6,         // 세로 비율 (50도 각도라 납작하게 시작)
      rX: 50,              // 각도 (50도 기울임)
      rY: 0, rZ: 0,        // 회전
      persp: 600           // 원근감
  };

  // 저장된 설정이 있으면 불러오고, 없으면 기본값 사용
  let val = JSON.parse(localStorage.getItem('projSettings')) || DEFAULT_SETTINGS;

  function saveSettings() {
      localStorage.setItem('projSettings', JSON.stringify(val));
  }

  // =========================================
  // [2] 캔버스 & 3D 컨테이너 생성 (구조 변경됨)
  // =========================================
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 1920;
  canvas.height = 1080;
  
  // 기존에는 없던 'Wrapper(포장지)'를 만듭니다. 
  // 캔버스를 이 안에 넣어야 3D 회전이 먹힙니다.
  const canvasWrapper = document.createElement('div');
  Object.assign(canvasWrapper.style, {
      position: 'absolute',
      width: '1920px',
      height: '1080px',
      transformOrigin: 'center center',
      // transition: 'transform 0.05s linear' // 반응 속도를 위해 트랜지션 제거
  });
  canvasWrapper.appendChild(canvas);
  stage.appendChild(canvasWrapper);

  // =========================================
  // [3] 가이드라인 (십자선) 생성 - G키로 토글
  // =========================================
  const guideLayer = document.createElement('div');
  Object.assign(guideLayer.style, {
      position: 'absolute',
      top: '0', left: '0',
      width: '100%', height: '100%',
      display: 'none', // 기본은 숨김
      zIndex: '9999',
      pointerEvents: 'none',
      border: '2px solid #0f0', // 외곽 테두리
      background: `
          linear-gradient(to right, transparent 49.9%, #0f0 49.9%, #0f0 50.1%, transparent 50.1%),
          linear-gradient(to bottom, transparent 49.9%, #0f0 49.9%, #0f0 50.1%, transparent 50.1%)
      `,
      backgroundSize: '100% 100%'
  });
  
  // 가이드도 3D 변형을 같이 받아야 정확한 위치를 잡음
  canvasWrapper.appendChild(guideLayer);

  // =========================================
  // [4] 비디오 & 카메라 설정 (기존 코드 100% 유지)
  // =========================================
  const vfxVideo = document.createElement('video');
  vfxVideo.src = 'assets/vfx/digital_scan_loop.mp4';
  vfxVideo.muted = true; vfxVideo.loop = true;     
  vfxVideo.play().catch(e => console.log("VFX 대기...")); 

  const videoInput = document.createElement('video');
  videoInput.autoplay = true; videoInput.playsinline = true; videoInput.muted = true;

  async function initProjectionCamera() {
      try {
          const stream = await navigator.mediaDevices.getUserMedia({ 
              video: { width: 1920, height: 1080 } 
          });
          videoInput.srcObject = stream;
      } catch (e) { console.error("카메라 실패:", e); }
  }
  initProjectionCamera();

  // stage를 비우는 함수 (Wrapper 구조에 맞춰 수정됨)
  function clearStage() {
    stage.style.background = "#000";
    ctx.clearRect(0, 0, canvas.width, canvas.height); 
    
    // 만약 Wrapper가 지워졌을 경우를 대비해 다시 추가 (안전장치)
    if (!stage.contains(canvasWrapper)) {
        stage.innerHTML = "";
        stage.appendChild(canvasWrapper);
    }
  }

  // =========================================
  // [5] 3D 변형 업데이트 함수 (새로 추가됨)
  // =========================================
  function updateTransform() {
      canvasWrapper.style.transform = `
          perspective(${val.persp}px)
          translate3d(${val.x}px, ${val.y}px, 0px)
          scale(${val.scale})
          scaleY(${val.scaleY}) 
          rotateX(${val.rX}deg)
          rotateY(${val.rY}deg)
          rotateZ(${val.rZ}deg)
      `;
      saveSettings(); // 바뀔 때마다 자동 저장
  }

  // =========================================
  // [6] 키보드 컨트롤 (새로 추가됨)
  // =========================================
  window.addEventListener('keydown', (e) => {
      // 입력 태그 안에서는 작동 안 하게 안전장치
      if (e.target.tagName === 'INPUT') return;

      const step = e.shiftKey ? 10 : 1; 
      const rotateStep = e.shiftKey ? 2 : 0.2; // 각도는 미세하게
      const scaleStep = 0.005;

      switch(e.key) {
          // --- 위치 ---
          case 'ArrowUp': val.y -= step; break;
          case 'ArrowDown': val.y += step; break;
          case 'ArrowLeft': val.x -= step; break;
          case 'ArrowRight': val.x += step; break;

          // --- 크기 ---
          case '+': case '=': val.scale += scaleStep; break;
          case '-': case '_': val.scale -= scaleStep; break;

          // --- 형태 보정 (50도 각도 상쇄 핵심) ---
          case '[': val.scaleY -= scaleStep; break; // 납작하게
          case ']': val.scaleY += scaleStep; break; // 길쭉하게

          // --- 각도 (Tilt) ---
          case 'w': case 'W': val.rX += rotateStep; break; // 더 눕히기
          case 's': case 'S': val.rX -= rotateStep; break; // 세우기
          
          // --- 회전 ---
          case 'a': case 'A': val.rY -= rotateStep; break; // 좌우 돌리기
          case 'd': case 'D': val.rY += rotateStep; break;
          case 'q': case 'Q': val.rZ -= rotateStep; break; // 갸우뚱
          case 'e': case 'E': val.rZ += rotateStep; break;

          // --- 기능 키 ---
          case 'g': case 'G': // 가이드(십자선) 토글
              guideLayer.style.display = (guideLayer.style.display === 'none') ? 'block' : 'none';
              break;
          
          case 'r': case 'R': // 초기화
              if(confirm("설정을 초기화할까요?")) {
                  val = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
                  updateTransform();
              }
              break;

          case 'Enter':
              console.log("현재 설정:", val);
              break;
      }
      updateTransform();
  });

  // =========================================
  // [7] 그리기 로직 (기존 코드 100% 유지)
  // =========================================
  function drawProjection(faceLandmarks, videoElement) {
      // 배경 클리어
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (!faceLandmarks) return;

      ctx.save();
      
      // 얼굴 외곽선 마스킹 (기존 로직 유지)
      const outlineIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 10];

      ctx.beginPath();
      outlineIndices.forEach((idx, i) => {
          const point = faceLandmarks[idx];
          if (i === 0) ctx.moveTo(point.x * canvas.width, point.y * canvas.height);
          else ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
      });
      ctx.closePath();
      ctx.clip(); // 마스킹 적용

      // 얼굴 그리기
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

      // VFX 합성 (기존 로직 유지)
      
      ctx.restore();
  }

  // =========================================
  // [8] 메시지 수신 (기존 코드 100% 유지)
  // =========================================
  window.addEventListener("message", (ev) => {
      const msg = ev.data || {};
      if (msg.type === "CLEAR") { 
          // clearStage() 호출 대신 캔버스만 지움 (Wrapper 유지 위해)
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (msg.type === "UPDATE_FACE") {
          drawProjection(msg.payload.landmarks, videoInput);
      }
      if (msg.type === "SHOW_RESULT_FRAME") {
          const img = new Image();
          img.onload = () => {
              // 결과 화면에서도 마스킹 적용
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              if (msg.payload.landmarks) {
                  drawProjection(msg.payload.landmarks, img); // img를 비디오 대신 전달
              } else {
                  // 혹시 랜드마크가 없으면 그냥 그림 (안전장치)
                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              }
          };
          img.src = msg.payload.image;
      }
  });

  // 초기 실행
  updateTransform();
})();
