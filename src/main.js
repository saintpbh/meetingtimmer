/* Premium Presentation Timer - Main Controller Logic (main.js)
   Engineered with requestAnimationFrame precision delta, Web Audio synth chime, and robust Tauri v2 IPC guards. */

// Safe retrieval of Tauri APIs with fallback logic
const getHasTauri = () => typeof window !== 'undefined' && window.__TAURI__ !== undefined;
const invoke = async (cmd, args) => {
  if (getHasTauri()) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  console.log(`[Tauri Mock] Invoke '${cmd}'`, args);
  if (cmd === 'get_monitors') {
    return [
      { name: "Primary Screen", width: 1920, height: 1080, x: 0, y: 0, scale_factor: 1.0, is_primary: true },
      { name: "Secondary Display", width: 1440, height: 900, x: 1920, y: 0, scale_factor: 2.0, is_primary: false }
    ];
  }
  return null;
};

// NDI Dedicated Offscreen Canvas Capture State
let ndiActiveState = false;
let ndiWidth = 1280;
let ndiHeight = 720;
let ndiFps = 30;
let ndiCanvas = null;
let ndiCtx = null;
let ndiWorker = null;

// 💡 NDI Garbage-Free Double Buffer Pool
let ndiBufferA = null;
let ndiBufferB = null;
let isNdiBufferA_InUse = false;
let isNdiBufferB_InUse = false;

// 💡 FFI-Safe Static Shared Buffer (Never transferred, dedicated strictly for Tauri FFI marshal)
let ndiFfiSharedBuffer = null;

function initNdiBufferPool(W, H) {
  const size = W * H * 4;
  ndiBufferA = new ArrayBuffer(size);
  ndiBufferB = new ArrayBuffer(size);
  isNdiBufferA_InUse = false;
  isNdiBufferB_InUse = false;
  
  // Allocate static FFI shared buffer
  ndiFfiSharedBuffer = new Uint8Array(size);
  
  console.log(`[NDI Performance] Zero-GC Pool & FFI-Safe Static Buffer Initialized (2x ArrayBuffer, 1x Uint8Array: ${size} bytes)`);
}


// 💡 NDI Real-time Dirty Frame Sync Cache (Key-Frame/I-Frame dynamic throttling to get 0ms CPU latency)
let lastNdiSecs = -9999;
let lastNdiRunning = false;
let lastNdiClockText = '';
let lastNdiNoticeText = '';
let lastNdiPrefsHash = '';
let ndiKeyframeCounter = 0;

// Application State Schema (SSOT)
const state = {
  // Timer States
  duration: 60,          // Default 1 minute in seconds
  remaining: 60,         // Remaining seconds
  isRunning: false,
  startTime: null,        // Base timestamp of the countdown
  accumulatedTime: 0,     // Total elapsed seconds before pause
  
  // Announcement Notice
  announcement: "",
  
  // Chime Status Checkpoints (Prevent duplicate triggers)
  chimeTriggeredWarning: false,
  chimeTriggeredTension: false,
  chimeTriggeredUrgent: false,
  
  // Settings (Deep Merge Targets)
  preferences: {
    timer: {
      visible: true,
      position: 'top-right',
      fontSize: 45,
      fontFamily: 'Outfit',
      offsetX: 20,
      offsetY: 20,
      bgOpacity: 68,
      bgColor: '#030715',
      theme: 'blue',
      clickthrough: true
    },
    clock: {
      visible: false,
      position: 'top-left',
      fontSize: 40,
      fontFamily: 'Outfit',
      offsetX: 20,
      offsetY: 20,
      bgOpacity: 68,
      bgColor: '#030715',
      theme: 'blue',
      is24h: true,
      showSeconds: true
    },
    notify: {
      visible: false,
      position: 'bottom-center',
      scale: 1.0,
      blur: true,
      bgOpacity: 80,
      bgColor: '#030715',
      offsetX: 20,
      offsetY: 20
    },
    chime: {
      enableWarning: true,
      warningTime: 60,
      warningSound: 'synth',
      warningColor: '#eab308',
      warningBlink: false,
      
      enableTension: true,
      tensionTime: 30,
      tensionSound: 'synth',
      tensionColor: '#f97316',
      tensionBlink: false,
      
      enableUrgent: true,
      urgentTime: 10,
      urgentSound: 'synth',
      urgentColor: '#ef4444',
      urgentBlink: true,
      
      volume: 80
    },
    ndi: {
      sourceName: 'Presentation Timer',
      resolution: '1280x720',
      fps: 30,
      
      timerVisible: true,
      timerFontSize: 45,
      timerFontFamily: 'Outfit',
      timerPosition: 'top-right',
      timerBgColor: '#030715',
      timerBgOpacity: 68,
      timerOffsetX: 20,
      timerOffsetY: 20,
      
      clockVisible: false,
      clockFontSize: 40,
      clockFontFamily: 'Outfit',
      clockPosition: 'top-left',
      clockBgColor: '#030715',
      clockBgOpacity: 68,
      clockOffsetX: 20,
      clockOffsetY: 20,
      clockIs24h: true,
      clockShowSeconds: true,
      
      notifyVisible: false,
      notifyBgColor: '#030715',
      notifyBgOpacity: 80,
      notifyPosition: 'bottom-center',
      notifyScale: 1.0,
      notifyOffsetX: 20,
      notifyOffsetY: 20
    },
    web: {
      enabled: true,
      theme: 'dark',
      fontSize: 300,
      fontFamily: 'Outfit',
      textColor: '#ffffff'
    }
  },
  
  // NDI Active State
  ndiActive: false,
  
  // Displays Cache
  monitors: []
};

// Web Audio API Synthesis Engine
let audioCtx = null;
let chimeBuffer = null;

async function loadChimeAsset() {
  try {
    const response = await fetch('assets/chime.wav');
    const arrayBuffer = await response.arrayBuffer();
    initAudio();
    audioCtx.decodeAudioData(arrayBuffer)
      .then(decoded => {
        chimeBuffer = decoded;
        console.log("Premium Chime WAV asset loaded successfully.");
      })
      .catch(err => {
        console.error("Audio decoding failed: ", err);
      });
  } catch (err) {
    console.warn("Failed to pre-load chime asset: ", err);
  }
}

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Syntehsize Perfect Double Bell tone natively or play custom WAV
function playSynthChime(type) {
  try {
    initAudio();
    const volumePercentage = state.preferences.chime.volume / 100;
    
    // Determine sound preference based on chime type
    let soundPref = 'synth';
    if (type === 'warning' || type === '60') {
      soundPref = state.preferences.chime.warningSound || 'synth';
    } else if (type === 'tension' || type === '30') {
      soundPref = state.preferences.chime.tensionSound || 'synth';
    } else if (type === 'urgent' || type === '10') {
      soundPref = state.preferences.chime.urgentSound || 'synth';
    }
    
    if (soundPref === 'muted') {
      console.log(`[Chime] Muted: ${type}`);
      return;
    }
    
    // Play custom pre-loaded WAV chime if preference is 'wav'
    if (soundPref === 'wav') {
      if (chimeBuffer) {
        const source = audioCtx.createBufferSource();
        source.buffer = chimeBuffer;
        
        const gainNode = audioCtx.createGain();
        gainNode.gain.setValueAtTime(volumePercentage, audioCtx.currentTime);
        
        source.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        source.start(0);
        return;
      } else {
        console.warn(`[Chime] WAV requested but not loaded. Falling back to synthetic.`);
      }
    }
    
    // Fallback or Synthetic Chime Engine
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.4 * volumePercentage, audioCtx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 1.8);
    
    // Choose frequencies based on trigger checkpoints
    let freqs = [440, 660]; // Defaults
    if (type === 'warning' || type === '60') {
      // Warning Chime: A5 + E6 (Perfect Fifth, pure sparkling tone)
      freqs = [880.00, 1318.51];
    } else if (type === 'tension' || type === '30') {
      // Tension Chime: C6 + G6 (Perfect Fifth, tension builder)
      freqs = [1046.50, 1567.98];
    } else if (type === 'urgent' || type === '10') {
      // Urgent Chime: E6 + Bb6 (Tritone dissonance, urgent warning beep)
      freqs = [1318.51, 932.33];
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.5 * volumePercentage, audioCtx.currentTime + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.6);
    }
    
    freqs.forEach(freq => {
      const osc = audioCtx.createOscillator();
      const oscGain = audioCtx.createGain();
      
      // Beautiful warm bell tone shaping
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      
      // Add quick pitch decay for organic attack strike
      osc.frequency.exponentialRampToValueAtTime(freq * 0.99, audioCtx.currentTime + 0.2);
      
      oscGain.gain.setValueAtTime(0.5, audioCtx.currentTime);
      
      osc.connect(oscGain);
      oscGain.connect(gainNode);
      osc.start();
      osc.stop(audioCtx.currentTime + ((type === 'urgent' || type === '10') ? 0.6 : 1.8));
    });
    
    gainNode.connect(audioCtx.destination);
  } catch (err) {
    console.error("Audio Synthesis error: ", err);
  }
}

// High Precision requestAnimationFrame Countdown Loop
let animationFrameId = null;
let backgroundTimerTickId = null; // 백그라운드 스로틀링 극복용 백업 타이머 틱

function startBackgroundTimerTick() {
  if (backgroundTimerTickId) return;
  // 100ms마다 타이머 루프를 강제로 보조 구동하여 requestAnimationFrame 스로틀링 시에도 오차가 나지 않도록 백업
  backgroundTimerTickId = setInterval(() => {
    if (state.isRunning) {
      const now = Date.now();
      const elapsedMs = now - state.startTime;
      const elapsedSeconds = elapsedMs / 1000;
      const currentRemaining = state.duration - (state.accumulatedTime + elapsedSeconds);
      state.remaining = currentRemaining;
      
      // UI 리렌더링 및 오버레이 싱크 강제 구동
      renderTimerUI();
      syncTimerWithOverlay();
      
      // NDI 송출도 백그라운드에서 강제 렌더링하도록 틱 주입 (NDI 굳음 영구 해제!)
      if (state.ndiActive && document.hidden) {
        renderNdiDedicatedFrame();
      }
    }
  }, 100);
}

function stopBackgroundTimerTick() {
  if (backgroundTimerTickId) {
    clearInterval(backgroundTimerTickId);
    backgroundTimerTickId = null;
  }
}

function updateTimerLoop() {
  if (!state.isRunning) return;
  
  const now = Date.now();
  const elapsedMs = now - state.startTime;
  const elapsedSeconds = elapsedMs / 1000;
  
  // Calculate remaining high precision seconds
  const currentRemaining = state.duration - (state.accumulatedTime + elapsedSeconds);
  state.remaining = currentRemaining;
  
  // Sync state UI
  renderTimerUI();
  
  // Checkpoint Chime Triggers (triggers exactly once within 1 second windows)
  const remSecInt = Math.floor(currentRemaining);
  
  const wTime = parseInt(state.preferences.chime.warningTime) || 60;
  const tTime = parseInt(state.preferences.chime.tensionTime) || 30;
  const uTime = parseInt(state.preferences.chime.urgentTime) || 10;
  
  if (state.preferences.chime.enableWarning && remSecInt === wTime && !state.chimeTriggeredWarning) {
    state.chimeTriggeredWarning = true;
    playSynthChime('warning');
  }
  if (state.preferences.chime.enableTension && remSecInt === tTime && !state.chimeTriggeredTension) {
    state.chimeTriggeredTension = true;
    playSynthChime('tension');
  }
  if (state.preferences.chime.enableUrgent && remSecInt === uTime && !state.chimeTriggeredUrgent) {
    state.chimeTriggeredUrgent = true;
    playSynthChime('urgent');
  }
  
  // Broadcast state changes directly to Tauri overlay window
  syncTimerWithOverlay();
  
  animationFrameId = requestAnimationFrame(updateTimerLoop);
}

// DOM Elements Query Cache to eliminate repeat search overhead
let cachedTimerTextEl = null;
let cachedProgressBarEl = null;
let cachedTimerStateLabelEl = null;
let cachedBtnToggleClock = null;

// State Synchronization Renderer (index.html)
function renderTimerUI() {
  if (!cachedTimerTextEl) cachedTimerTextEl = document.getElementById('timer-text');
  if (!cachedProgressBarEl) cachedProgressBarEl = document.getElementById('timer-progress-bar');
  if (!cachedTimerStateLabelEl) cachedTimerStateLabelEl = document.getElementById('timer-state-label');
  
  const timerTextEl = cachedTimerTextEl;
  const progressBarEl = cachedProgressBarEl;
  const timerStateLabelEl = cachedTimerStateLabelEl;
  
  const absRemaining = Math.abs(state.remaining);
  const m = Math.floor(absRemaining / 60);
  const s = Math.floor(absRemaining % 60);
  
  const minutesStr = String(m).padStart(2, '0');
  const secondsStr = String(s).padStart(2, '0');
  const isOvertime = state.remaining < 0;
  
  // Display negative prefix if overtime
  timerTextEl.textContent = `${isOvertime ? '-' : ''}${minutesStr}:${secondsStr}`;
  
  // Update state label
  if (state.isRunning) {
    timerStateLabelEl.textContent = isOvertime ? "OVERTIME!" : "RUNNING";
    timerStateLabelEl.style.color = isOvertime ? 'var(--accent-danger)' : 'var(--accent-success)';
  } else {
    timerStateLabelEl.textContent = isOvertime ? "OVERTIME PAUSED" : "PAUSED";
    timerStateLabelEl.style.color = 'var(--accent-warning)';
  }
  
  // Determine alarm thresholds, colors, and blink settings
  const wTime = parseInt(state.preferences.chime.warningTime) || 60;
  const tTime = parseInt(state.preferences.chime.tensionTime) || 30;
  const uTime = parseInt(state.preferences.chime.urgentTime) || 10;
  
  const wColor = state.preferences.chime.warningColor || '#eab308';
  const tColor = state.preferences.chime.tensionColor || '#f97316';
  const uColor = state.preferences.chime.urgentColor || '#ef4444';
  
  const wBlink = state.preferences.chime.warningBlink;
  const tBlink = state.preferences.chime.tensionBlink;
  const uBlink = state.preferences.chime.urgentBlink;
  
  let activeColor = 'var(--accent-color)';
  let activeBlink = false;
  
  if (isOvertime) {
    // If overtime, use urgent settings as baseline or default fallback
    activeColor = state.preferences.chime.enableUrgent ? uColor : 'var(--accent-danger)';
    activeBlink = state.preferences.chime.enableUrgent ? uBlink : true;
  } else {
    if (state.preferences.chime.enableUrgent && state.remaining <= uTime) {
      activeColor = uColor;
      activeBlink = uBlink;
    } else if (state.preferences.chime.enableTension && state.remaining <= tTime) {
      activeColor = tColor;
      activeBlink = tBlink;
    } else if (state.preferences.chime.enableWarning && state.remaining <= wTime) {
      activeColor = wColor;
      activeBlink = wBlink;
    }
  }
  
  // Apply colors dynamically to ring stroke and digits text
  progressBarEl.style.stroke = activeColor;
  timerTextEl.style.color = activeColor;
  
  // Inject alert color CSS variable for breathing pulse glow
  progressBarEl.style.setProperty('--alert-glow-color', activeColor);
  timerTextEl.style.setProperty('--alert-glow-color', activeColor);

  // Sync the quick toggle clock button state
  if (!cachedBtnToggleClock) cachedBtnToggleClock = document.getElementById('btn-toggle-clock');
  const btnToggleClock = cachedBtnToggleClock;
  if (btnToggleClock) {
    if (state.preferences.clock.visible) {
      btnToggleClock.classList.add('active');
    } else {
      btnToggleClock.classList.remove('active');
    }
  }
  
  // Sync the quick toggle IP Viewer button state
  const btnToggleIpViewer = document.getElementById('btn-toggle-ip-viewer');
  if (btnToggleIpViewer) {
    const isWebActive = !!(state.preferences.web?.enabled);
    btnToggleIpViewer.classList.toggle('active', isWebActive);
  }
  
  // Manage blink animation class based on settings and running state
  if (activeBlink && state.isRunning) {
    timerTextEl.classList.add('blink-active');
    progressBarEl.classList.add('blink-active');
  } else {
    timerTextEl.classList.remove('blink-active');
    progressBarEl.classList.remove('blink-active');
  }
  
  // Circular Dashoffset progress ring math
  const radius = 100;
  const circumference = 2 * Math.PI * radius;
  let progressRatio = 0;
  
  if (state.duration > 0) {
    progressRatio = isOvertime ? 1 : (state.duration - state.remaining) / state.duration;
  }
  
  const offset = circumference - (progressRatio * circumference);
  progressBarEl.style.strokeDasharray = circumference;
  progressBarEl.style.strokeDashoffset = offset;
}

// Transmit state directly to overlay window
let lastSharedTime = 0;
function syncTimerWithOverlay(force = false, includePrefs = false) {
  const now = Date.now();
  // Throttle overlay broadcast frequency to 30fps (max every 33ms) to prevent FFI IPC bottlenecks
  if (!force && now - lastSharedTime < 33) return;
  lastSharedTime = now;
  
  // Calculate SSOT local clock representation
  const clockNow = new Date();
  let hours = clockNow.getHours();
  const mins = String(clockNow.getMinutes()).padStart(2, '0');
  const secs = String(clockNow.getSeconds()).padStart(2, '0');
  let ampm = '';
  const is24h = state.preferences.clock?.is24h !== undefined ? state.preferences.clock.is24h : true;
  const showSecs = state.preferences.clock?.showSeconds !== undefined ? state.preferences.clock.showSeconds : true;
  if (!is24h) {
    ampm = hours >= 12 ? 'PM ' : 'AM ';
    hours = hours % 12 || 12;
  }
  const hStr = String(hours).padStart(2, '0');
  const clockText = showSecs ? `${ampm}${hStr}:${mins}:${secs}` : `${ampm}${hStr}:${mins}`;
  
  const payload = {
    remaining: state.remaining,
    duration: state.duration,
    isRunning: state.isRunning,
    announcement: state.announcement,
    clockText: clockText // SSOT Clock Sync
  };
  
  // 💡 Only include heavy preferences payload when explicit settings changes occur
  if (includePrefs || force) {
    payload.preferences = state.preferences;
  }
  
  invoke('share_timer_state', { stateJson: JSON.stringify(payload) }).catch(err => {
    console.error("Overlay IPC Sync Failed:", err);
  });
}

// Helper: show overlay window if any layer is active, hide if none
function updateOverlayWindowVisibility() {
  const anyVisible = state.preferences.timer.visible || state.preferences.clock.visible || state.preferences.notify.visible;
  invoke('set_overlay_visible', { visible: anyVisible }).catch(err => console.error(err));
  syncTimerWithOverlay(true);
}

// Start, Pause & Reset Orchestration
function startTimer() {
  if (state.isRunning) return;
  initAudio();
  state.isRunning = true;
  state.startTime = Date.now();
  
  // 💡 Auto enable and show overlay timer on start
  state.preferences.timer.visible = true;
  const chkOverlayTimer = document.getElementById('chk-overlay-timer');
  if (chkOverlayTimer) chkOverlayTimer.checked = true;
  
  updateOverlayWindowVisibility();
  packAndSavePreferences(false);
  
  document.getElementById('lbl-start-pause').textContent = "Pause";
  document.getElementById('btn-start-pause').className = "btn-primary btn-pause-theme";
  document.getElementById('btn-start-pause').style.background = 'var(--accent-warning)';
  
  updateTimerLoop();
  startBackgroundTimerTick(); // 백그라운드 백업 틱 활성화
}

function pauseTimer() {
  if (!state.isRunning) return;
  state.isRunning = false;
  
  // Lock elapsed delta time
  const elapsedMs = Date.now() - state.startTime;
  state.accumulatedTime += elapsedMs / 1000;
  
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  stopBackgroundTimerTick(); // 백그라운드 백업 틱 비활성화
  
  document.getElementById('lbl-start-pause').textContent = "Start";
  document.getElementById('btn-start-pause').className = "btn-primary";
  document.getElementById('btn-start-pause').style.background = 'var(--accent-color)';
  
  renderTimerUI();
  syncTimerWithOverlay(true);
}

function resetTimer() {
  pauseTimer();
  state.accumulatedTime = 0;
  state.remaining = state.duration;
  
  // Clear synth warning flags
  state.chimeTriggeredWarning = false;
  state.chimeTriggeredTension = false;
  state.chimeTriggeredUrgent = false;
  
  renderTimerUI();
  syncTimerWithOverlay(true);
}

// Preset and Custom Duration updates
function setDuration(seconds) {
  pauseTimer();
  state.duration = seconds;
  state.remaining = seconds;
  state.accumulatedTime = 0;
  
  // Clear synth warning flags
  state.chimeTriggeredWarning = false;
  state.chimeTriggeredTension = false;
  state.chimeTriggeredUrgent = false;
  
  renderTimerUI();
  syncTimerWithOverlay(true);
}

// Robust deep merging helper for local storage schema migration
function mergeDeep(target, source) {
  if (!source) return target;
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object') {
      if (!target[key]) target[key] = {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function validateAndRepairPreferences() {
  const defaults = {
    timer: { position: 'top-right', fontSize: 45, fontFamily: 'Outfit', offsetX: 20, offsetY: 20, bgOpacity: 68, bgColor: '#030715', theme: 'blue', clickthrough: true, visible: false },
    clock: { position: 'top-left', fontSize: 40, fontFamily: 'Outfit', offsetX: 20, offsetY: 20, bgOpacity: 68, bgColor: '#030715', theme: 'blue', is24h: true, showSeconds: true, visible: false },
    notify: { position: 'bottom-center', scale: 1.0, blur: true, bgOpacity: 80, bgColor: '#030715', offsetX: 20, offsetY: 20, visible: false },
    chime: {
      enableWarning: true,
      warningTime: 60,
      warningSound: 'synth',
      warningColor: '#eab308',
      warningBlink: false,
      enableTension: true,
      tensionTime: 30,
      tensionSound: 'synth',
      tensionColor: '#f97316',
      tensionBlink: false,
      enableUrgent: true,
      urgentTime: 10,
      urgentSound: 'synth',
      urgentColor: '#ef4444',
      urgentBlink: true,
      volume: 80
    },
    ndi: {
      sourceName: 'Presentation Timer',
      resolution: '1280x720',
      fps: 30,
      timerVisible: true,
      timerRingVisible: true, // NDI 타이머 원형 프로그레스 링 송출 스위치 추가
      alphaKeyEnabled: true, // NDI 알파 채널(투명 배경) 송출 스위치 추가
      timerFontSize: 45,
      timerFontFamily: 'Outfit',
      timerPosition: 'top-right',
      timerBgColor: '#030715',
      timerBgOpacity: 68,
      timerOffsetX: 20,
      timerOffsetY: 20,
      clockVisible: false,
      clockFontSize: 40,
      clockFontFamily: 'Outfit',
      clockPosition: 'top-left',
      clockBgColor: '#030715',
      clockBgOpacity: 68,
      clockOffsetX: 20,
      clockOffsetY: 20,
      clockIs24h: true,
      clockShowSeconds: true,
      notifyVisible: false,
      notifyPosition: 'bottom-center',
      notifyBgColor: '#030715',
      notifyBgOpacity: 80,
      notifyScale: 1.0,
      notifyOffsetX: 20,
      notifyOffsetY: 20
    },
    web: {
      enabled: true,
      theme: 'dark',
      fontSize: 300,
      fontFamily: 'Outfit',
      textColor: '#ffffff'
    }
  };

  if (!state.preferences || typeof state.preferences !== 'object') {
    state.preferences = JSON.parse(JSON.stringify(defaults));
    return;
  }

  // Schema migration for old chime structure
  if (state.preferences.chime) {
    if (state.preferences.chime.enable60 !== undefined) {
      state.preferences.chime.enableWarning = state.preferences.chime.enable60;
      delete state.preferences.chime.enable60;
    }
    if (state.preferences.chime.enable30 !== undefined) {
      state.preferences.chime.enableTension = state.preferences.chime.enable30;
      delete state.preferences.chime.enable30;
    }
    if (state.preferences.chime.enable10 !== undefined) {
      state.preferences.chime.enableUrgent = state.preferences.chime.enable10;
      delete state.preferences.chime.enable10;
    }
    if (state.preferences.chime.warningTime === undefined) state.preferences.chime.warningTime = 60;
    if (state.preferences.chime.tensionTime === undefined) state.preferences.chime.tensionTime = 30;
    if (state.preferences.chime.urgentTime === undefined) state.preferences.chime.urgentTime = 10;
    
    if (state.preferences.chime.warningSound === undefined) state.preferences.chime.warningSound = 'synth';
    if (state.preferences.chime.warningColor === undefined) state.preferences.chime.warningColor = '#eab308';
    if (state.preferences.chime.warningBlink === undefined) state.preferences.chime.warningBlink = false;
    
    if (state.preferences.chime.tensionSound === undefined) state.preferences.chime.tensionSound = 'synth';
    if (state.preferences.chime.tensionColor === undefined) state.preferences.chime.tensionColor = '#f97316';
    if (state.preferences.chime.tensionBlink === undefined) state.preferences.chime.tensionBlink = false;
    
    if (state.preferences.chime.urgentSound === undefined) state.preferences.chime.urgentSound = 'synth';
    if (state.preferences.chime.urgentColor === undefined) state.preferences.chime.urgentColor = '#ef4444';
    if (state.preferences.chime.urgentBlink === undefined) state.preferences.chime.urgentBlink = true;
  }

  for (const category in defaults) {
    if (!state.preferences[category] || typeof state.preferences[category] !== 'object') {
      state.preferences[category] = JSON.parse(JSON.stringify(defaults[category]));
      continue;
    }
    for (const key in defaults[category]) {
      if (state.preferences[category][key] === undefined || state.preferences[category][key] === null) {
        state.preferences[category][key] = defaults[category][key];
      }
    }
  }

  // Safety migration for newly added theme property
  if (state.preferences.timer.theme === undefined) {
    state.preferences.timer.theme = 'blue';
  }
  if (state.preferences.clock.theme === undefined) {
    state.preferences.clock.theme = 'blue';
  }
  if (state.preferences.web === undefined) {
    state.preferences.web = {
      enabled: true,
      theme: 'dark',
      fontSize: 300,
      fontFamily: 'Outfit',
      textColor: '#ffffff'
    };
  }
}

// Preferences persistence
function loadPreferences() {
  try {
    const raw = localStorage.getItem('premium_timer_preferences');
    if (raw) {
      const parsed = JSON.parse(raw);
      state.preferences = mergeDeep(state.preferences, parsed);
    }
  } catch (err) {
    console.error("Failed to load preferences: ", err);
  } finally {
    validateAndRepairPreferences();
  }
}

let overlaySyncTimeout = null;
function savePreferences(immediate = false) {
  try {
    localStorage.setItem('premium_timer_preferences', JSON.stringify(state.preferences));
    
    if (immediate) {
      if (overlaySyncTimeout) clearTimeout(overlaySyncTimeout);
      syncTimerWithOverlay(true, true);
    } else {
      // 💡 Debounce heavy Overlay FFI IPC sync to guarantee 0ms button click latency
      if (overlaySyncTimeout) clearTimeout(overlaySyncTimeout);
      overlaySyncTimeout = setTimeout(() => {
        syncTimerWithOverlay(true, true);
      }, 50);
    }
  } catch (err) {
    console.error("Failed to save preferences: ", err);
  }
}

function applyTheme(themeName) {
  const validThemes = ['blue', 'gold', 'rose'];
  const selectedTheme = validThemes.includes(themeName) ? themeName : 'blue';
  
  // Remove previous theme classes and apply selected to body
  document.body.classList.remove('theme-blue', 'theme-gold', 'theme-rose');
  document.body.classList.add(`theme-${selectedTheme}`);
  
  state.preferences.timer.theme = selectedTheme;
  state.preferences.clock.theme = selectedTheme;
  
  const defaultBgColors = {
    blue: '#030715',
    gold: '#110d05',
    rose: '#140a0b'
  };
  
  // Auto update clock/notice bg values for unified premium experience
  state.preferences.timer.bgColor = defaultBgColors[selectedTheme];
  state.preferences.clock.bgColor = defaultBgColors[selectedTheme];
  state.preferences.notify.bgColor = defaultBgColors[selectedTheme];
  
  // Update HTML background pickers
  const timerBgColorInput = document.getElementById('timer-bg-color');
  if (timerBgColorInput) timerBgColorInput.value = defaultBgColors[selectedTheme];
  const clockBgColorInput = document.getElementById('clock-bg-color');
  if (clockBgColorInput) clockBgColorInput.value = defaultBgColors[selectedTheme];
  const notifyBgColorInput = document.getElementById('notify-bg-color');
  if (notifyBgColorInput) notifyBgColorInput.value = defaultBgColors[selectedTheme];
  
  // Deactivate active preset chips because custom backgrounds changed
  document.querySelectorAll('#timer-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('#clock-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('#notify-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
  
  // Make sure chip active state is visually highlighted immediately
  document.querySelectorAll('#timer-theme-grid .theme-chip').forEach(chip => {
    if (chip.getAttribute('data-theme') === selectedTheme) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  document.querySelectorAll('#clock-theme-grid .theme-chip').forEach(chip => {
    if (chip.getAttribute('data-theme') === selectedTheme) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  savePreferences();
  fitMainWindowToContent();
}

// Dynamic display scan
async function scanMonitors() {
  try {
    const res = await invoke('get_monitors');
    if (res && res.length > 0) {
      state.monitors = res;
      const selectEl = document.getElementById('select-monitor');
      selectEl.innerHTML = '';
      
      res.forEach((m, idx) => {
        const option = document.createElement('option');
        option.value = idx;
        option.textContent = `${m.name || `Display ${idx + 1}`} (${m.width}x${m.height})${m.is_primary ? ' [Primary]' : ''}`;
        if (m.is_primary) option.selected = true;
        selectEl.appendChild(option);
      });
      
      // Automatically fit target screen configuration
      updateOverlayScreenPlacement();
    }
  } catch (err) {
    console.error("Display scanning failed: ", err);
  }
}

async function updateOverlayScreenPlacement() {
  const selectEl = document.getElementById('select-monitor');
  const selectedIdx = selectEl.value;
  if (selectedIdx === 'primary' || !state.monitors[selectedIdx]) return;
  
  const m = state.monitors[selectedIdx];
  try {
    await invoke('move_overlay_to_monitor', {
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height
    });
  } catch (err) {
    console.error("Error setting window bounds: ", err);
  }
}

async function fitMainWindowToContent() {
  if (!getHasTauri()) return;
  
  requestAnimationFrame(async () => {
    const container = document.querySelector('.app-container');
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    // Safety margin to fully accommodate body padding (16px * 2 = 32px) and native OS window borders/title bar (approx 28px on macOS)
    const width = Math.ceil(rect.width) + 44; 
    const height = Math.ceil(rect.height) + 64; 
    
    try {
      await invoke('set_main_content_size', { width, height });
      console.log(`[Tauri] Dynamic window layout synced to content size: ${width}x${height}`);
    } catch (err) {
      console.error("[Tauri] Failed to dynamically adjust content viewport: ", err);
    }
  });
}

// Presentation App state cache
let activePptApp = 'None';

// Scan active presentation software
async function scanPresentationApp() {
  const statusDot = document.getElementById('ppt-status-dot');
  const appNameEl = document.getElementById('ppt-active-app');
  const settingsAppEl = document.getElementById('ppt-settings-app-name');
  
  if (!getHasTauri()) {
    activePptApp = 'None';
    if (appNameEl) { appNameEl.textContent = 'Standalone'; appNameEl.classList.remove('detected'); }
    if (statusDot) { statusDot.classList.remove('active'); statusDot.title = 'Standalone Mode'; }
    if (settingsAppEl) { settingsAppEl.textContent = 'Standalone Mode'; settingsAppEl.classList.remove('detected'); }
    return;
  }
  
  try {
    const res = await invoke('detect_presentation_app');
    activePptApp = res;
    
    if (res === 'PowerPoint') {
      if (appNameEl) { appNameEl.textContent = 'PowerPoint'; appNameEl.classList.add('detected'); }
      if (statusDot) { statusDot.classList.add('active'); statusDot.title = 'Microsoft PowerPoint'; }
      if (settingsAppEl) { settingsAppEl.textContent = 'Microsoft PowerPoint 🟢'; settingsAppEl.classList.add('detected'); }
    } else if (res === 'Keynote') {
      if (appNameEl) { appNameEl.textContent = 'Keynote'; appNameEl.classList.add('detected'); }
      if (statusDot) { statusDot.classList.add('active'); statusDot.title = 'Apple Keynote'; }
      if (settingsAppEl) { settingsAppEl.textContent = 'Apple Keynote 🟢'; settingsAppEl.classList.add('detected'); }
    } else {
      if (appNameEl) { appNameEl.textContent = 'No App'; appNameEl.classList.remove('detected'); }
      if (statusDot) { statusDot.classList.remove('active'); statusDot.title = 'No Active App'; }
      if (settingsAppEl) { settingsAppEl.textContent = 'No Active App 🔴'; settingsAppEl.classList.remove('detected'); }
    }
  } catch (err) {
    console.error("Presentation scan failed:", err);
    if (appNameEl) { appNameEl.textContent = 'Error'; appNameEl.classList.remove('detected'); }
    if (statusDot) { statusDot.classList.remove('active'); statusDot.title = 'Scan Error'; }
    if (settingsAppEl) { settingsAppEl.textContent = `Error: ${err}`; settingsAppEl.classList.remove('detected'); }
  } finally {
    fitMainWindowToContent();
  }
}

// Send control commands to PowerPoint/Keynote
async function sendPresentationControl(action, slideIndex = null) {
  // Try to scan active app first if None to give seamless experience
  if (activePptApp === 'None' && getHasTauri()) {
    try {
      activePptApp = await invoke('detect_presentation_app');
    } catch (_) {}
  }
  
  const statusEl = document.getElementById('ppt-active-app');
  
  if (!getHasTauri()) {
    console.log(`[Tauri Mock] sendPresentationControl invoked: ${action} with index ${slideIndex}`);
    return;
  }
  
  if (activePptApp === 'None') {
    if (statusEl) {
      statusEl.textContent = 'Please run PPT or Keynote! ⚠️';
      statusEl.classList.remove('detected');
      setTimeout(scanPresentationApp, 2000);
    }
    return;
  }
  
  try {
    const args = {
      appName: activePptApp,
      action: action,
      slideIndex: slideIndex !== null ? parseInt(slideIndex) : null
    };
    await invoke('control_presentation', args);
    console.log(`[Tauri] Presentation control command sent successfully:`, args);
    
    // Auto sync state representation
    scanPresentationApp();
  } catch (err) {
    console.error("Failed to send presentation control command: ", err);
  }
}

// === NDI Output Control ===
async function startNdiSender() {
  if (state.ndiActive) return;
  
  const name = state.preferences.ndi.sourceName || 'Presentation Timer';
  const resParts = (state.preferences.ndi.resolution || '1280x720').split('x');
  const width = parseInt(resParts[0]) || 1280;
  const height = parseInt(resParts[1]) || 720;
  const fps = parseInt(state.preferences.ndi.fps) || 30;
  
  try {
    const result = await invoke('ndi_start_sender', { name, width, height, fps });
    console.log('[NDI]', result);
    state.ndiActive = true;
    
    // Initialize Main-thread Offscreen Canvas for GPU NDI rendering
    ndiWidth = width;
    ndiHeight = height;
    ndiFps = fps;
    ndiActiveState = true;
    
    startNdiCaptureLoop();
    updateNdiUI();
  } catch (err) {
    console.error('[NDI] Start failed:', err);
    const statusEl = document.getElementById('ndi-status-text');
    if (statusEl) { statusEl.textContent = `❌ ${err}`; statusEl.classList.remove('active'); }
    
    // 💡 NDI 런타임 미설치 시 프리미엄 한글 경고 다이얼로그 (Fail-Safe 1)
    const errStr = String(err);
    if (errStr.includes('NDIlib_initialize') || errStr.includes('runtime') || errStr.includes('install') || errStr.includes('dylib')) {
      alert("📡 [NDI 런타임 미설치 탐지]\n\n시스템에 NDI Advanced SDK 또는 NDI Runtime이 설치되어 있지 않습니다.\n\n해결방법:\n1. NDI 공식 웹사이트(https://ndi.video/ 또는 https://ndi.link/SDK-Apple-Mac)에서 Mac용 NDI Runtime 또는 NDI Tools를 다운로드하여 설치해 주십시오.\n2. 설치 후 앱을 완전히 껐다가 다시 기동하시면, 즉각 NDI 30fps 초고속 자막 송출이 정상 활성화됩니다.");
    } else {
      alert(`📡 [NDI 기동 실패]\n\n사유: ${err}\n\n시스템 네트워크 환경 및 포트 충돌 여부를 점검해 주십시오.`);
    }
  }
}

async function stopNdiSender() {
  if (!state.ndiActive) return;
  
  try {
    await invoke('ndi_stop_sender');
    console.log('[NDI] Sender stopped');
  } catch (err) {
    console.error('[NDI] Stop error:', err);
  }
  
  ndiActiveState = false;
  stopNdiCaptureLoop();
  
  state.ndiActive = false;
  updateNdiUI();
}

// 💡 NDI Zero-Delay Hot-Reboot Sequence (Fail-Safe 3 - 시나리오 C)
async function triggerNdiHotReboot() {
  console.log('[NDI Fail-Safe] Triggering NDI Hot-Reboot sequence...');
  const name = state.preferences.ndi.sourceName || 'Presentation Timer';
  const resParts = (state.preferences.ndi.resolution || '1280x720').split('x');
  const width = parseInt(resParts[0]) || 1280;
  const height = parseInt(resParts[1]) || 720;
  const fps = parseInt(state.preferences.ndi.fps) || 30;
  
  // 1. 구 렌더 루프 및 버퍼 풀 정리
  ndiActiveState = false;
  stopNdiCaptureLoop();
  
  // 2. 구 네이티브 NDI Sender 인스턴스 해제
  try {
    await invoke('ndi_stop_sender');
  } catch (_) {}
  
  // 3. 신규 파라미터 적용 및 네이티브 가동
  try {
    await invoke('ndi_start_sender', { name, width, height, fps });
    
    ndiWidth = width;
    ndiHeight = height;
    ndiFps = fps;
    ndiActiveState = true;
    
    // 4. 신규 루프 시동
    startNdiCaptureLoop();
    updateNdiUI();
    console.log('[NDI Fail-Safe] Hot-Reboot completed successfully.');
  } catch (err) {
    console.error('[NDI Fail-Safe] Hot-Reboot failed:', err);
    state.ndiActive = false;
    updateNdiUI();
  }
}

function toggleNdiSender() {
  if (state.ndiActive) {
    stopNdiSender();
  } else {
    startNdiSender();
  }
}

function updateNdiUI() {
  const btn = document.getElementById('btn-toggle-ndi');
  const statusEl = document.getElementById('ndi-status-text');
  
  if (btn) {
    btn.classList.toggle('active', state.ndiActive);
  }
  if (statusEl) {
    if (state.ndiActive) {
      const res = state.preferences.ndi.resolution || '1280x720';
      const fps = state.preferences.ndi.fps || 30;
      statusEl.textContent = `🟢 Sending (${res} @${fps}fps)`;
      statusEl.classList.add('active');
    } else {
      statusEl.textContent = '⚫ Stopped';
      statusEl.classList.remove('active');
    }
  }
}

// === NDI Dedicated GPU Capture Engine ===
function startNdiCaptureLoop() {
  stopNdiCaptureLoop(); // Cleanup
  
  ndiCanvas = document.createElement('canvas');
  ndiCanvas.width = ndiWidth;
  ndiCanvas.height = ndiHeight;
  ndiCtx = ndiCanvas.getContext('2d', { willReadFrequently: true });
  
  // 💡 더블 버퍼링용 링 버퍼 풀 초기화
  initNdiBufferPool(ndiWidth, ndiHeight);
  
  // Create inline worker to manage scheduling, backpressure control and double-buffer recycling
  const workerCode = `
    let timerId = null;
    let isSending = false;
    let backlogBuffer = null;
    let backlogName = null;
    let activeWidth = 1280;
    let activeHeight = 720;
    
    // 300ms 만료 안전 락 해제용 타이머 캐시
    let activeTimeoutId = null;
    
    self.onmessage = function(e) {
      const data = e.data;
      if (data.action === 'start') {
        activeWidth = data.width || 1280;
        activeHeight = data.height || 720;
        const interval = 1000 / data.fps;
        if (timerId) clearInterval(timerId);
        timerId = setInterval(() => {
          self.postMessage({ type: 'tick' });
        }, interval);
      } else if (data.action === 'stop') {
        if (timerId) {
          clearInterval(timerId);
          timerId = null;
        }
        if (activeTimeoutId) {
          clearTimeout(activeTimeoutId);
          activeTimeoutId = null;
        }
        backlogBuffer = null;
        backlogName = null;
        isSending = false;
      } else if (data.action === 'processFrame') {
        const buffer = data.buffer;
        const name = data.bufferName;
        
        if (isSending) {
          // 백프레셔 감지: 이미 FFI가 전송 중이면 새 버퍼를 백로그에 넣어두고, 기존에 밀려있던 이전 백로그는 즉시 반환(드롭)
          if (backlogBuffer) {
            self.postMessage({ type: 'recycle', buffer: backlogBuffer, bufferName: backlogName }, [backlogBuffer]);
          }
          backlogBuffer = buffer;
          backlogName = name;
          return;
        }
        
        isSending = true;
        
        // 💡 300ms 만료 안전 락 해제 타임아웃 (시나리오 B - Fail-Safe 2)
        if (activeTimeoutId) clearTimeout(activeTimeoutId);
        activeTimeoutId = setTimeout(() => {
          if (isSending) {
            isSending = false;
            activeTimeoutId = null;
            if (backlogBuffer) {
              const nextBuffer = backlogBuffer;
              const nextName = backlogName;
              backlogBuffer = null;
              backlogName = null;
              isSending = true;
              self.postMessage({ type: 'sendToFFI', buffer: nextBuffer, bufferName: nextName, width: activeWidth, height: activeHeight }, [nextBuffer]);
            }
          }
        }, 300);
        
        self.postMessage({ type: 'sendToFFI', buffer, bufferName: name, width: activeWidth, height: activeHeight }, [buffer]);
      } else if (data.action === 'ffiCompleted') {
        isSending = false;
        if (activeTimeoutId) {
          clearTimeout(activeTimeoutId);
          activeTimeoutId = null;
        }
        
        // 반환된 사용 완료 버퍼는 메인 스레드로 리사이클
        const returnedBuffer = data.buffer;
        const name = data.bufferName;
        if (returnedBuffer) {
          self.postMessage({ type: 'recycle', buffer: returnedBuffer, bufferName: name }, [returnedBuffer]);
        }
        
        // 대기 중인 백로그 프레임이 존재하면 곧바로 연쇄 FFI 기동
        if (backlogBuffer) {
          const nextBuffer = backlogBuffer;
          const nextName = backlogName;
          backlogBuffer = null;
          backlogName = null;
          isSending = true;
          self.postMessage({ type: 'sendToFFI', buffer: nextBuffer, bufferName: nextName, width: activeWidth, height: activeHeight }, [nextBuffer]);
        }
      }
    };
  `;
  
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  ndiWorker = new Worker(workerUrl);
  
  ndiWorker.onmessage = function(e) {
    const data = e.data;
    if (data.type === 'tick' && ndiActiveState) {
      renderNdiDedicatedFrame();
    } else if (data.type === 'sendToFFI') {
      const buffer = data.buffer;
      const bufferName = data.bufferName;
      const W = data.width;
      const H = data.height;
      const expectedSize = W * H * 4;
      
      // 💡 해상도 핫스왑 등 과도기에서 버퍼 크기 불일치 발생 시, 안전하게 프레임 드롭하여 JS/Rust 크래시 차단
      if (buffer.byteLength !== expectedSize) {
        if (ndiWorker) {
          ndiWorker.postMessage({ action: 'ffiCompleted', buffer, bufferName }, [buffer]);
        }
        return;
      }
      
      // 💡 1. FFI 전송 전용 정적 공유 버퍼에 초고속 카피 (V8 FFI 비동기 소유권 파괴 완벽 방지)
      if (ndiFfiSharedBuffer && ndiFfiSharedBuffer.byteLength === expectedSize) {
        ndiFfiSharedBuffer.set(new Uint8Array(buffer));
      } else {
        ndiFfiSharedBuffer = new Uint8Array(expectedSize);
        ndiFfiSharedBuffer.set(new Uint8Array(buffer));
      }
      
      // 💡 2. 복사를 마치자마자 FFI 비동기 완료를 전혀 기다리지 않고 원래 버퍼는 즉시 워커로 즉각 환원 리사이클!
      if (ndiWorker) {
        ndiWorker.postMessage({ action: 'ffiCompleted', buffer, bufferName }, [buffer]);
      }
      
      // 💡 3. FFI 호출은 무효화 위험이 0%인 고정 ndiFfiSharedBuffer를 타겟 삼아 100% 영구 안전 송출!
      invoke('ndi_send_frame', {
        rgba: ndiFfiSharedBuffer,
        width: W,
        height: H
      })
      .catch((err) => {
        console.error("[NDI FFI] Safe pipeline send failed:", err);
      });
    } else if (data.type === 'recycle') {
      const buffer = data.buffer;
      const name = data.bufferName;
      if (name === 'A') {
        ndiBufferA = buffer;
        isNdiBufferA_InUse = false;
      } else if (name === 'B') {
        ndiBufferB = buffer;
        isNdiBufferB_InUse = false;
      }
    }
  };
  
  ndiWorker.postMessage({ action: 'start', fps: ndiFps, width: ndiWidth, height: ndiHeight });
  console.log(`[NDI Dedicated] 30fps GPU rendering loop initialized: ${ndiWidth}x${ndiHeight}`);
}

function stopNdiCaptureLoop() {
  if (ndiWorker) {
    ndiWorker.postMessage({ action: 'stop' });
    ndiWorker.terminate();
    ndiWorker = null;
  }
  ndiCanvas = null;
  ndiCtx = null;
  ndiBufferA = null;
  ndiBufferB = null;
  ndiFfiSharedBuffer = null;
  isNdiBufferA_InUse = false;
  isNdiBufferB_InUse = false;
  console.log('[NDI Dedicated] GPU rendering loop, Buffer pool & Shared transporter stopped');
}

// Main-Window Independent GPU NDI Renderer (Allows customizable theme skins for broadcasting)
function renderNdiDedicatedFrame() {
  if (!ndiCtx) return;
  
  const prefs = state.preferences || {};
  const currentSecs = Math.floor(state.remaining || 0);
  const currentRunning = !!state.isRunning;
  const currentNotice = state.announcement || '';
  
  // Create super lightweight prefs hash to detect NDI layout changes instantly
  const currentPrefsHash = JSON.stringify({
    timerVis: prefs.ndi?.timerVisible,
    timerSize: prefs.ndi?.timerFontSize,
    timerFont: prefs.ndi?.timerFontFamily,
    timerPos: prefs.ndi?.timerPosition,
    clockVis: prefs.ndi?.clockVisible,
    clockSize: prefs.ndi?.clockFontSize,
    clockPos: prefs.ndi?.clockPosition,
    notifyVis: prefs.notify?.visible,
    notifyScale: prefs.notify?.scale,
    notifyPos: prefs.notify?.position
  });
  
  // Get current clock display text
  const clockNow = new Date();
  let hours = clockNow.getHours();
  const mins = String(clockNow.getMinutes()).padStart(2, '0');
  const secs = String(clockNow.getSeconds()).padStart(2, '0');
  let ampm = '';
  const is24h = prefs.clock?.is24h !== undefined ? prefs.clock.is24h : true;
  const showSecs = prefs.clock?.showSeconds !== undefined ? prefs.clock.showSeconds : true;
  if (!is24h) {
    ampm = hours >= 12 ? 'PM ' : 'AM ';
    hours = hours % 12 || 12;
  }
  const hStr = String(hours).padStart(2, '0');
  const clockTextDisplay = showSecs ? `${ampm}${hStr}:${mins}:${secs}` : `${ampm}${hStr}:${mins}`;
  
  // 💡 Check if anything has actually changed (Dirty State Detection)
  // 1초 단위로 숫자가 변할 때만 극도로 가볍게 전송(Ultra-efficient 1s Throttling)하여
  // GPU-to-CPU Readback (getImageData)의 오버헤드를 극단적으로 0에 수렴시킴으로써 NDI 송출 지연(Latency)을 최소화합니다!
  const isStateDirty = 
    currentSecs !== lastNdiSecs ||
    currentRunning !== lastNdiRunning ||
    clockTextDisplay !== lastNdiClockText ||
    currentNotice !== lastNdiNoticeText ||
    currentPrefsHash !== lastNdiPrefsHash;
    
  ndiKeyframeCounter++;
  
  // 💡 Keyframe Safeguard: Force transmit a frame every 3 seconds (90 ticks at 30fps) 
  // to ensure new receiver connections get the frame instantly, otherwise drop static duplicate frames.
  const isKeyframeTrigger = ndiKeyframeCounter >= (ndiFps * 3);
  
  if (!isStateDirty && !isKeyframeTrigger) {
    // 💡 0ms Instant Bypass: Drop FFI IPC rendering to eliminate all Main Thread bottleneck lags!
    return;
  }
  
  // Reset Keyframe counter if we are transmitting
  if (isKeyframeTrigger) {
    ndiKeyframeCounter = 0;
  }
  
  // Update state cache
  lastNdiSecs = currentSecs;
  lastNdiRunning = currentRunning;
  lastNdiClockText = clockTextDisplay;
  lastNdiNoticeText = currentNotice;
  lastNdiPrefsHash = currentPrefsHash;
  
  const ctx = ndiCtx;
  const W = ndiWidth;
  const H = ndiHeight;
  
  // Clear VRAM buffer depending on Alpha Key transparency setting
  if (prefs.ndi?.alphaKeyEnabled !== false) {
    // 💡 투명 배경 (Alpha Channel 활성화) - 방송용 오버레이에 최적
    ctx.clearRect(0, 0, W, H);
  } else {
    // 💡 불투명 검은색 배경 (Alpha Channel 비활성화)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
  }
  
  // --- Render Timer ---
  const timerVisible = prefs.ndi?.timerVisible !== undefined ? prefs.ndi.timerVisible : true;
  if (timerVisible) {
    const remaining = state.remaining || 0;
    const isOvertime = remaining < 0;
    const absR = Math.abs(remaining);
    const m = String(Math.floor(absR / 60)).padStart(2, '0');
    const s = String(Math.floor(absR % 60)).padStart(2, '0');
    const timerTextDisplay = `${isOvertime ? '-' : ''}${m}:${s}`;
    
    let fontSize = Math.round((prefs.ndi?.timerFontSize !== undefined ? prefs.ndi.timerFontSize : 45) * (W / 1920));
    
    // 💡 화면 이탈 및 글꼴 실종 원천 방어 쉴드 (Auto Scale-down Guard)
    // 폰트 크기가 NDI 해상도 세로 높이 H의 90%를 초과할 경우 세로 높이의 90%로 강제 Clamp 보정!
    const maxSafeTimerSize = Math.round(H * 0.9);
    if (fontSize > maxSafeTimerSize) {
      fontSize = maxSafeTimerSize;
    }
    
    const fontFamily = prefs.ndi?.timerFontFamily || 'Outfit';
    
    let textColor = '#ffffff';
    const chime = prefs.chime || {};
    if (isOvertime) {
      textColor = chime.urgentColor || '#ef4444';
    } else if (chime.enableUrgent && remaining <= (chime.urgentTime || 10)) {
      textColor = chime.urgentColor || '#ef4444';
    } else if (chime.enableTension && remaining <= (chime.tensionTime || 30)) {
      textColor = chime.tensionColor || '#f97316';
    } else if (chime.enableWarning && remaining <= (chime.warningTime || 60)) {
      textColor = chime.warningColor || '#eab308';
    }
    
    const timerPos = prefs.ndi?.timerPosition || 'top-right';
    const offsetX = 20;
    const offsetY = 20;
    const pos = calculateNdiPosition(timerPos, offsetX, offsetY, W, H, fontSize);
    
    const bgOpacity = 0.68;
    const bgColor = prefs.timer?.bgColor || '#030715';
    const bgRgb = hexToRgbNdi(bgColor);
    const textWidth = measureTextNdi(ctx, timerTextDisplay, fontSize, fontFamily);
    
    const pillW = textWidth + fontSize * 1.2;
    const pillH = fontSize * 1.6;
    ctx.fillStyle = `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${bgOpacity})`;
    roundRectNdi(ctx, pos.x - pillW / 2, pos.y - pillH / 2, pillW, pillH, fontSize * 0.35);
    
    ctx.font = `700 ${fontSize}px '${fontFamily}', sans-serif`;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(timerTextDisplay, pos.x, pos.y);
    
    const dotSize = Math.max(4, Math.round(fontSize * 0.15));
    ctx.beginPath();
    ctx.arc(pos.x - textWidth / 2 - dotSize * 2, pos.y, dotSize, 0, Math.PI * 2);
    ctx.fillStyle = state.isRunning ? '#22c55e' : (isOvertime ? textColor : '#64748b');
    ctx.fill();
  }
  
  // --- Render Clock ---
  const clockVisible = prefs.ndi?.clockVisible !== undefined ? prefs.ndi.clockVisible : false;
  if (clockVisible) {
    let fontSize = Math.round((prefs.ndi?.clockFontSize !== undefined ? prefs.ndi.clockFontSize : 40) * (W / 1920));
    
    // 💡 화면 이탈 및 글꼴 실종 원천 방어 쉴드 (Auto Scale-down Guard)
    const maxSafeClockSize = Math.round(H * 0.9);
    if (fontSize > maxSafeClockSize) {
      fontSize = maxSafeClockSize;
    }
    
    const fontFamily = prefs.timer?.fontFamily || 'Outfit';
    const clockPos = prefs.ndi?.clockPosition || 'top-left';
    const offsetX = 20;
    const offsetY = 20;
    const pos = calculateNdiPosition(clockPos, offsetX, offsetY, W, H, fontSize);
    
    const bgOpacity = 0.68;
    const bgColor = prefs.clock?.bgColor || '#030715';
    const bgRgb = hexToRgbNdi(bgColor);
    const textWidth = measureTextNdi(ctx, clockTextDisplay, fontSize, fontFamily);
    const pillW = textWidth + fontSize * 1.2;
    const pillH = fontSize * 1.6;
    
    ctx.fillStyle = `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${bgOpacity})`;
    roundRectNdi(ctx, pos.x - pillW / 2, pos.y - pillH / 2, pillW, pillH, fontSize * 0.35);
    
    ctx.font = `600 ${fontSize}px '${fontFamily}', sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clockTextDisplay, pos.x, pos.y);
  }
  
  // --- Render Notice ---
  const noticeVisible = prefs.notify?.visible !== undefined ? prefs.notify.visible : false;
  const announcement = state.announcement || '';
  if (noticeVisible && announcement.trim()) {
    const fontSize = Math.round(28 * (W / 1920) * (prefs.notify?.scale || 1.0));
    const noticePos = prefs.notify?.position || 'bottom-center';
    const offsetX = 20;
    const offsetY = 20;
    const pos = calculateNdiPosition(noticePos, offsetX, offsetY, W, H, fontSize);
    
    const bgOpacity = 0.80;
    const bgColor = prefs.notify?.bgColor || '#030715';
    const bgRgb = hexToRgbNdi(bgColor);
    const textWidth = measureTextNdi(ctx, `💬 ${announcement}`, fontSize, 'Outfit');
    const pillW = textWidth + fontSize * 1.5;
    const pillH = fontSize * 2;
    
    ctx.fillStyle = `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${bgOpacity})`;
    roundRectNdi(ctx, pos.x - pillW / 2, pos.y - pillH / 2, pillW, pillH, fontSize * 0.4);
    
    ctx.font = `500 ${fontSize}px 'Outfit', sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`💬 ${announcement}`, pos.x, pos.y);
  }
  
  // 💡 더블 버퍼링용 가용 링 버퍼 선택 (Garbage-Free Double-Buffering)
  let targetBuffer = null;
  let bufferName = '';
  if (!isNdiBufferA_InUse && ndiBufferA && ndiBufferA.byteLength > 0) {
    targetBuffer = ndiBufferA;
    bufferName = 'A';
    isNdiBufferA_InUse = true;
  } else if (!isNdiBufferB_InUse && ndiBufferB && ndiBufferB.byteLength > 0) {
    targetBuffer = ndiBufferB;
    bufferName = 'B';
    isNdiBufferB_InUse = true;
  }
  
  // 두 버퍼가 모두 FFI 전송 대기/진행 중으로 바쁘다면, 메인 UI 스레드 멈춤(Stall) 방지를 위해 이 프레임은 버림(Bypass)
  if (!targetBuffer) {
    return;
  }
  
  // Extract pixel buffer
  const imageData = ctx.getImageData(0, 0, W, H);
  
  const expectedSize = W * H * 4;
  if (targetBuffer.byteLength !== expectedSize) {
    // 💡 해상도 핫스왑 등 과도기에서 버퍼 크기 불일치 발생 시, 안전하게 프레임 드롭하여 JS/Rust 크래시 차단
    console.warn(`[NDI Buffer SafeGuard] Size mismatch during resolution hot-swap: expected ${expectedSize} got ${targetBuffer.byteLength}. Dropping frame.`);
    if (bufferName === 'A') isNdiBufferA_InUse = false;
    else if (bufferName === 'B') isNdiBufferB_InUse = false;
    return;
  }
  
  // 0ms 고속 바이트 복사 (TypedArray.set)
  const destArray = new Uint8Array(targetBuffer);
  destArray.set(imageData.data);
  
  // Web Worker에게 버퍼 소유권을 넘김 (Zero-Copy Transferable Object 전송)
  if (ndiWorker) {
    ndiWorker.postMessage({
      action: 'processFrame',
      buffer: targetBuffer,
      bufferName: bufferName
    }, [targetBuffer]);
  }
}

// === NDI Dedicated GPU Renderer Utilities ===
function hexToRgbNdi(hex) {
  let c = hex.substring(1);
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  return {
    r: parseInt(c.substring(0, 2), 16),
    g: parseInt(c.substring(2, 4), 16),
    b: parseInt(c.substring(4, 6), 16)
  };
}

function calculateNdiPosition(zone, offsetX, offsetY, W, H, fontSize) {
  let x = W / 2, y = H / 2;
  
  if (zone.includes('left'))   x = offsetX + fontSize * 2;
  if (zone.includes('right'))  x = W - offsetX - fontSize * 2;
  if (zone.includes('top'))    y = offsetY + fontSize;
  if (zone.includes('bottom')) y = H - offsetY - fontSize;
  
  if (zone === 'center-center' || zone === 'top-center' || zone === 'bottom-center') {
    x = W / 2;
  }
  if (zone === 'center-left' || zone === 'center-center' || zone === 'center-right') {
    y = H / 2;
  }
  
  return { x, y };
}

function measureTextNdi(ctx, text, fontSize, fontFamily) {
  ctx.font = `700 ${fontSize}px '${fontFamily}', sans-serif`;
  return ctx.measureText(text).width;
}

function roundRectNdi(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

// DOM Setup & UI Event Bindings
window.addEventListener('DOMContentLoaded', () => {
  // Load and apply persistent preferences
  loadPreferences();
  
  // 💡 즉시 설정 값을 HTML DOM 엘리먼트에 세팅하여, 
  // 차후 모달 미작동 상태에서 단순 설정 팩킹 시 돔 기본값(45px 등) 덮어쓰기 유실을 원천 예방!
  syncPrefUIState();
  
  // 💡 Embedded Web Overlay Local IP Auto-detection & Clipboard Copy Binding
  const initIpViewerAddress = async () => {
    const ipAddrEl = document.getElementById('ip-viewer-address');
    const copyBtnEl = document.getElementById('btn-copy-ip-viewer-link');
    if (!ipAddrEl || !copyBtnEl) return;
    
    let localIp = '127.0.0.1';
    try {
      // Tauri Native command를 호출하여 현재 머신의 로컬 IP 자동 획득!
      localIp = await invoke('get_local_ip');
    } catch (err) {
      console.warn('[IP Sync] Failed to get local IP via Tauri invoke, falling back to window hostname:', err);
      localIp = window.location.hostname || '127.0.0.1';
    }
    
    const viewerUrl = `http://${localIp}:3003`;
    ipAddrEl.textContent = viewerUrl;
    
    // 복사 버튼 리스너 바인딩
    copyBtnEl.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(viewerUrl);
        
        // 💡 프리미엄 마이크로 인터랙션 피드백 (📋 복사 -> ✅ 복사됨!)
        copyBtnEl.textContent = '✅ 복사됨!';
        copyBtnEl.style.background = 'var(--accent-success)';
        
        setTimeout(() => {
          copyBtnEl.textContent = '📋 복사';
          copyBtnEl.style.background = '';
        }, 1500);
      } catch (err) {
        console.error('[Clipboard] Failed to copy URL:', err);
      }
    });
  };
  initIpViewerAddress();
  
  // Apply initial theme
  applyTheme(state.preferences.timer.theme);
  
  // Pre-load custom WAV chime asset
  loadChimeAsset();
  
  // 사용자의 첫 터치/클릭 조작 시 Web Audio 컨텍스트 사전 활성화 (Autoplay Policy 잠금 선제 해제 및 초기 재생 렉 차단)
  const initAudioWarmup = () => {
    initAudio();
    window.removeEventListener('click', initAudioWarmup);
    window.removeEventListener('keydown', initAudioWarmup);
  };
  window.addEventListener('click', initAudioWarmup);
  window.addEventListener('keydown', initAudioWarmup);
  
  // Web Fonts 적재 완료 직후 NDI 및 UI 리프레시 강제 실행 (Arial 등의 밋밋한 기본 폰트 일시 노출 및 틀어짐 원천 차단)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      console.log("[Font Sync] Premium fonts fully loaded. Triggering instant canvas refresh.");
      renderTimerUI();
      if (state.ndiActive) {
        renderNdiDedicatedFrame();
      }
    });
  }
  
  // Scan monitors immediately
  scanMonitors();
  
  // Dynamic resize immediately
  fitMainWindowToContent();
  
  // Register full window load listener as secondary safeguard
  window.addEventListener('load', fitMainWindowToContent);

  
  // Sync overlay visibility state changes from outside
  if (getHasTauri()) {
    const { listen } = window.__TAURI__.event;
    listen('overlay-visibility-changed', (event) => {
      const active = event.payload;
      // If the overlay was hidden externally (e.g. Escape from overlay), sync all layer toggles off
      if (!active) {
        state.preferences.timer.visible = false;
        state.preferences.clock.visible = false;
        state.preferences.notify.visible = false;
        const chkT = document.getElementById('chk-overlay-timer');
        const chkC = document.getElementById('chk-overlay-clock');
        const chkN = document.getElementById('chk-overlay-notice');
        if (chkT) chkT.checked = false;
        if (chkC) chkC.checked = false;
        if (chkN) chkN.checked = false;
      }
    });
    
    listen('overlay-dragged', (event) => {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const { type, offsetX, offsetY } = payload;
      
      if (type === 'timer') {
        state.preferences.timer.offsetX = Math.round(offsetX);
        state.preferences.timer.offsetY = Math.round(offsetY);
        const inputX = document.getElementById('timer-offset-x');
        const inputY = document.getElementById('timer-offset-y');
        if (inputX) inputX.value = Math.round(offsetX);
        if (inputY) inputY.value = Math.round(offsetY);
      } else if (type === 'notice') {
        state.preferences.notify.offsetX = Math.round(offsetX);
        state.preferences.notify.offsetY = Math.round(offsetY);
        const inputX = document.getElementById('notify-offset-x');
        const inputY = document.getElementById('notify-offset-y');
        if (inputX) inputX.value = Math.round(offsetX);
        if (inputY) inputY.value = Math.round(offsetY);
      } else if (type === 'clock') {
        state.preferences.clock.offsetX = Math.round(offsetX);
        state.preferences.clock.offsetY = Math.round(offsetY);
        const inputX = document.getElementById('clock-offset-x');
        const inputY = document.getElementById('clock-offset-y');
        if (inputX) inputX.value = Math.round(offsetX);
        if (inputY) inputY.value = Math.round(offsetY);
      }
      
      // Auto-save to local storage and sync overlays silently
      packAndSavePreferences(false);
    });
  }
  
  // Set default countdown duration visualizer
  renderTimerUI();
  
  // Core Buttons
  document.getElementById('btn-start-pause').addEventListener('click', () => {
    if (state.isRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  });
  
  document.getElementById('btn-reset').addEventListener('click', resetTimer);
  
  // Clock Toggle Button Click Handler
  const btnToggleClock = document.getElementById('btn-toggle-clock');
  if (btnToggleClock) {
    btnToggleClock.addEventListener('click', () => {
      state.preferences.clock.visible = !state.preferences.clock.visible;
      
      // 💡 Sync overlay window visibility immediately
      updateOverlayWindowVisibility();
      
      // 💡 Sync independent toggle checkbox in settings UI
      const chkOverlayClock = document.getElementById('chk-overlay-clock');
      if (chkOverlayClock) chkOverlayClock.checked = !!state.preferences.clock.visible;
      
      renderTimerUI();
      packAndSavePreferences(false);
    });
  }
  
  // === Presentation Controller Bindings ===
  // Auto-scan presentation app immediately on launch
  scanPresentationApp();
  
  // Rescan on window focus to ensure perfect sync without manual refresh
  window.addEventListener('focus', scanPresentationApp);

  const btnDetectPpt = document.getElementById('btn-detect-ppt');
  if (btnDetectPpt) {
    btnDetectPpt.addEventListener('click', scanPresentationApp);
  }

  const btnPptStart = document.getElementById('btn-ppt-start');
  if (btnPptStart) {
    btnPptStart.addEventListener('click', () => sendPresentationControl('start'));
  }

  const btnPptStop = document.getElementById('btn-ppt-stop');
  if (btnPptStop) {
    btnPptStop.addEventListener('click', () => sendPresentationControl('stop'));
  }

  const btnPptPrev = document.getElementById('btn-ppt-prev');
  if (btnPptPrev) {
    btnPptPrev.addEventListener('click', () => sendPresentationControl('prev'));
  }

  const btnPptNext = document.getElementById('btn-ppt-next');
  if (btnPptNext) {
    btnPptNext.addEventListener('click', () => sendPresentationControl('next'));
  }

  const btnPptJump = document.getElementById('btn-ppt-jump');
  const inputPptSlide = document.getElementById('input-ppt-slide');
  if (btnPptJump && inputPptSlide) {
    const handleJump = () => {
      const val = parseInt(inputPptSlide.value);
      if (!isNaN(val) && val > 0) {
        sendPresentationControl('goto', val);
      }
    };
    btnPptJump.addEventListener('click', handleJump);
    inputPptSlide.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleJump();
        inputPptSlide.blur();
      }
    });
  }

  // Bind global keyboard remote slide show control (ArrowLeft/ArrowRight)
  window.addEventListener('keydown', (e) => {
    // Ignore keystrokes when typing inside inputs or textareas to prevent interference
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    
    if (e.key === 'ArrowRight' || e.key === 'Space') {
      sendPresentationControl('next');
    } else if (e.key === 'ArrowLeft') {
      sendPresentationControl('prev');
    }
  });
  
  // === IP Timer Quick Toggle Binding ===
  const btnToggleIpViewer = document.getElementById('btn-toggle-ip-viewer');
  if (btnToggleIpViewer) {
    btnToggleIpViewer.addEventListener('click', () => {
      state.preferences.web.enabled = !state.preferences.web.enabled;
      
      const chkWebEnabled = document.getElementById('checkbox-web-enabled');
      if (chkWebEnabled) chkWebEnabled.checked = !!state.preferences.web.enabled;
      
      renderTimerUI();
      packAndSavePreferences(false, false, true);
    });
  }
  
  // === NDI Output Bindings ===
  const btnToggleNdi = document.getElementById('btn-toggle-ndi');
  if (btnToggleNdi) {
    btnToggleNdi.addEventListener('click', toggleNdiSender);
  }
  
  const btnNdiStart = document.getElementById('btn-ndi-start');
  if (btnNdiStart) {
    btnNdiStart.addEventListener('click', startNdiSender);
  }
  
  const btnNdiStop = document.getElementById('btn-ndi-stop');
  if (btnNdiStop) {
    btnNdiStop.addEventListener('click', stopNdiSender);
  }
  
  const inputNdiName = document.getElementById('input-ndi-name');
  if (inputNdiName) {
    inputNdiName.addEventListener('change', (e) => {
      state.preferences.ndi.sourceName = e.target.value || 'Presentation Timer';
      packAndSavePreferences(false);
    });
  }
  
  const selectNdiRes = document.getElementById('select-ndi-resolution');
  if (selectNdiRes) {
    selectNdiRes.addEventListener('change', (e) => {
      state.preferences.ndi.resolution = e.target.value;
      packAndSavePreferences(false);
      
      // 💡 해상도 실시간 핫스왑 지원 (Fail-Safe 3)
      if (state.ndiActive) {
        triggerNdiHotReboot();
      }
    });
  }
  
  const selectNdiFps = document.getElementById('select-ndi-fps');
  if (selectNdiFps) {
    selectNdiFps.addEventListener('change', (e) => {
      state.preferences.ndi.fps = parseInt(e.target.value) || 30;
      packAndSavePreferences(false);
      
      // 💡 FPS 실시간 핫스왑 지원 (Fail-Safe 3)
      if (state.ndiActive) {
        triggerNdiHotReboot();
      }
    });
  }
  
  // Time Preset Row
  document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const secs = parseInt(e.currentTarget.getAttribute('data-seconds'));
      setDuration(secs);
      
      // Sync numerical fields
      const hrs = Math.floor(secs / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      const scs = secs % 60;
      document.getElementById('input-hours').value = hrs;
      document.getElementById('input-minutes').value = mins;
      document.getElementById('input-seconds').value = scs;
    });
  });
  
  // Custom Time picker
  document.getElementById('btn-apply-custom-time').addEventListener('click', () => {
    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
    
    const hrs = parseInt(document.getElementById('input-hours').value) || 0;
    const mins = parseInt(document.getElementById('input-minutes').value) || 0;
    const scs = parseInt(document.getElementById('input-seconds').value) || 0;
    
    const totalSecs = (hrs * 3600) + (mins * 60) + scs;
    if (totalSecs > 0) {
      setDuration(totalSecs);
    }
  });
  
  // Quick Increment chips
  document.querySelectorAll('.btn-chip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const offset = parseInt(e.currentTarget.getAttribute('data-time'));
      // Keep running if already running, just add to duration and remaining
      state.duration = Math.max(1, state.duration + offset);
      state.remaining = Math.max(1, state.remaining + offset);
      
      // Deactivate active preset chips because duration has changed
      document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
      
      renderTimerUI();
      syncTimerWithOverlay(true);
    });
  });
  
  // === Independent Overlay Layer Toggles ===
  
  // Timer layer toggle
  const chkOverlayTimer = document.getElementById('chk-overlay-timer');
  chkOverlayTimer.addEventListener('change', (e) => {
    state.preferences.timer.visible = e.target.checked;
    updateOverlayWindowVisibility();
    packAndSavePreferences(false);
  });
  
  // Clock layer toggle
  const chkOverlayClock = document.getElementById('chk-overlay-clock');
  chkOverlayClock.addEventListener('change', (e) => {
    state.preferences.clock.visible = e.target.checked;
    updateOverlayWindowVisibility();
    packAndSavePreferences(false);
  });
  
  // Notice layer toggle
  const chkOverlayNotice = document.getElementById('chk-overlay-notice');
  chkOverlayNotice.addEventListener('change', (e) => {
    state.preferences.notify.visible = e.target.checked;
    updateOverlayWindowVisibility();
    packAndSavePreferences(false);
  });
  
  // Mouse Clickthrough switch
  const chkClickthrough = document.getElementById('chk-overlay-clickthrough');
  chkClickthrough.addEventListener('change', (e) => {
    const active = e.target.checked;
    state.preferences.timer.clickthrough = active;
    invoke('set_overlay_clickthrough', { clickthrough: active }).catch(err => console.error(err));
    packAndSavePreferences(false);
  });
  
  // Target Screen Select
  document.getElementById('select-monitor').addEventListener('change', updateOverlayScreenPlacement);
  document.getElementById('btn-refresh-monitors').addEventListener('click', scanMonitors);
  
  // Broadcaster notice text fields
  const btnSend = document.getElementById('btn-send-announce');
  const btnClear = document.getElementById('btn-clear-announce');
  const inputAnnounce = document.getElementById('input-announce');
  
  btnSend.addEventListener('click', () => {
    state.announcement = inputAnnounce.value.trim();
    
    // 💡 Auto enable and show overlay notice layer on sending if there is content
    if (state.announcement) {
      state.preferences.notify.visible = true;
      const chkOverlayNotice = document.getElementById('chk-overlay-notice');
      if (chkOverlayNotice) chkOverlayNotice.checked = true;
      updateOverlayWindowVisibility();
      packAndSavePreferences(false);
    }
    
    syncTimerWithOverlay(true);
  });
  
  btnClear.addEventListener('click', () => {
    inputAnnounce.value = "";
    state.announcement = "";
    syncTimerWithOverlay(true);
  });

  // Timer Font selector grid click handler
  const fontGrid = document.getElementById('timer-font-grid');
  if (fontGrid) {
    fontGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.font-chip');
      if (chip) {
        fontGrid.querySelectorAll('.font-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preferences.timer.fontFamily = chip.getAttribute('data-font');
        packAndSavePreferences(false);
      }
    });
  }

  // Timer Theme selector grid click handler
  const themeGrid = document.getElementById('timer-theme-grid');
  if (themeGrid) {
    themeGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.theme-chip');
      if (chip) {
        themeGrid.querySelectorAll('.theme-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const themeName = chip.getAttribute('data-theme');
        applyTheme(themeName);
      }
    });
  }
  
  // Dialog Open/Close (Preferences)
  const dialog = document.getElementById('settings-dialog');
  document.getElementById('btn-open-settings').addEventListener('click', () => {
    syncPrefUIState();
    dialog.showModal();
  });
  
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    dialog.close();
  });
  
  // Light dismiss on clicking dialog backdrop
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });
  
  // Support macOS preferences shortcut (Cmd + ,) & Esc to close overlay
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      syncPrefUIState();
      dialog.showModal();
    } else if (e.key === 'Escape') {
      // Do not override dialog closed native behavior if dialog modal is active
      if (dialog.open) return;
      
      // Escape hides all overlay layers
      state.preferences.timer.visible = false;
      state.preferences.clock.visible = false;
      state.preferences.notify.visible = false;
      const chkT = document.getElementById('chk-overlay-timer');
      const chkC = document.getElementById('chk-overlay-clock');
      const chkN = document.getElementById('chk-overlay-notice');
      if (chkT) chkT.checked = false;
      if (chkC) chkC.checked = false;
      if (chkN) chkN.checked = false;
      invoke('set_overlay_visible', { visible: false }).catch(err => console.error(err));
      syncTimerWithOverlay(true);
    }
  });
  
  // Preferences settings modal tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      
      e.currentTarget.classList.add('active');
      const paneId = e.currentTarget.getAttribute('data-tab');
      document.getElementById(paneId).classList.add('active');
    });
  });
  
  // Setup Pos grids selector widgets
  setupPosGrid('timer-position-grid', 'timer');
  setupPosGrid('clock-position-grid', 'clock');
  setupPosGrid('notify-position-grid', 'notify');
  
  // Setup NDI specific 3x3 Pos grids selector widgets
  setupNdiPosGrid('ndi-timer-position-grid', 'timerPosition');
  setupNdiPosGrid('ndi-clock-position-grid', 'clockPosition');
  
  // Range value sync labels
  bindSliderLabel('timer-font-size', 'lbl-timer-font-size');
  bindSliderLabel('timer-bg-opacity', 'lbl-timer-bg-opacity');
  bindSliderLabel('clock-font-size', 'lbl-clock-font-size');
  bindSliderLabel('clock-bg-opacity', 'lbl-clock-bg-opacity');
  bindSliderLabel('notify-scale', 'lbl-notify-scale');
  bindSliderLabel('notify-bg-opacity', 'lbl-notify-bg-opacity');
  bindSliderLabel('chime-volume', 'lbl-chime-volume');
  
  // NDI Dedicated Two-way Font Size Slider & Number input Sync bindings
  bindSliderAndNumInput('input-ndi-timer-size', 'input-ndi-timer-size-num');
  bindSliderAndNumInput('input-ndi-clock-size', 'input-ndi-clock-size-num');
  
  // Web Output Two-way Font Size Slider & Number input Sync bindings
  bindSliderAndNumInput('input-web-size', 'input-web-size-num');
  
  // Web Output theme toggles
  const btnWebThemeDark = document.getElementById('btn-web-theme-dark');
  const btnWebThemeTransparent = document.getElementById('btn-web-theme-transparent');
  if (btnWebThemeDark && btnWebThemeTransparent) {
    btnWebThemeDark.addEventListener('click', () => {
      btnWebThemeDark.classList.add('active');
      btnWebThemeTransparent.classList.remove('active');
      state.preferences.web.theme = 'dark';
      packAndSavePreferences(false, false, true);
    });
    btnWebThemeTransparent.addEventListener('click', () => {
      btnWebThemeDark.classList.remove('active');
      btnWebThemeTransparent.classList.add('active');
      state.preferences.web.theme = 'transparent';
      packAndSavePreferences(false, false, true);
    });
  }

  // Web Output Font family grid
  const webFontGrid = document.getElementById('web-font-grid');
  if (webFontGrid) {
    webFontGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.font-chip');
      if (chip) {
        webFontGrid.querySelectorAll('.font-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preferences.web.fontFamily = chip.getAttribute('data-font');
        packAndSavePreferences(false, false, true);
      }
    });
  }

  // Web Output Color presets
  const webColorPresets = document.getElementById('web-color-presets');
  if (webColorPresets) {
    webColorPresets.addEventListener('click', (e) => {
      const chip = e.target.closest('.color-chip');
      if (chip && !chip.classList.contains('btn-custom-color')) {
        webColorPresets.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preferences.web.textColor = chip.getAttribute('data-color');
        
        const customColorInput = document.getElementById('color-web-custom');
        if (customColorInput) customColorInput.value = state.preferences.web.textColor;
        
        packAndSavePreferences(false, false, true);
      }
    });
  }

  // Web Output Custom Color Input
  const colorWebCustom = document.getElementById('color-web-custom');
  if (colorWebCustom) {
    colorWebCustom.addEventListener('input', (e) => {
      const customColor = e.target.value;
      state.preferences.web.textColor = customColor;
      
      const btnCustomColor = document.getElementById('btn-web-custom-color');
      if (btnCustomColor) {
        btnCustomColor.style.background = customColor;
        webColorPresets.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
        btnCustomColor.classList.add('active');
      }
      
      packAndSavePreferences(false, false, true);
    });
  }
  
  // Synthetic Chime tests
  document.getElementById('btn-test-chime-warning').addEventListener('click', () => { initAudio(); playSynthChime('warning'); });
  document.getElementById('btn-test-chime-tension').addEventListener('click', () => { initAudio(); playSynthChime('tension'); });
  document.getElementById('btn-test-chime-urgent').addEventListener('click', () => { initAudio(); playSynthChime('urgent'); });
  
  // Real-time Live Settings listeners
  const liveInputs = [
    'timer-font-size', 'timer-bg-opacity', 'timer-offset-x', 'timer-offset-y', 'timer-bg-color',
    'clock-font-size', 'clock-bg-opacity', 'chk-clock-24h', 'chk-clock-seconds', 'clock-offset-x', 'clock-offset-y', 'clock-bg-color',
    'notify-scale', 'chk-notify-blur', 'notify-bg-opacity', 'notify-offset-x', 'notify-offset-y', 'notify-bg-color',
    'chk-chime-warning', 'input-chime-warning-time', 'chk-chime-tension', 'input-chime-tension-time', 'chk-chime-urgent', 'input-chime-urgent-time', 'chime-volume',
    'select-chime-warning-sound', 'color-chime-warning-color', 'chk-chime-warning-blink',
    'select-chime-tension-sound', 'color-chime-tension-color', 'chk-chime-tension-blink',
    'select-chime-urgent-sound', 'color-chime-urgent-color', 'chk-chime-urgent-blink',
    
    // NDI Configuration inputs (Source name, resolution, fps are handled as standard field changes)
    'input-ndi-name', 'select-ndi-resolution', 'select-ndi-fps',
    'checkbox-ndi-timer-visible', 'checkbox-ndi-alpha-enabled', 'input-ndi-timer-size', 'input-ndi-timer-size-num',
    'checkbox-ndi-clock-visible', 'input-ndi-clock-size', 'input-ndi-clock-size-num',
    
    // Web Overlay Settings live inputs
    'checkbox-web-enabled', 'input-web-size', 'input-web-size-num', 'color-web-custom'
  ];
  
  liveInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const eventType = (el.type === 'range' || el.type === 'color' || el.type === 'number') ? 'input' : 'change';
      el.addEventListener(eventType, () => {
        const labelId = `lbl-${id}`;
        const labelEl = document.getElementById(labelId);
        if (labelEl) labelEl.textContent = el.value;
        
        if (id === 'timer-bg-color') {
          document.querySelectorAll('#timer-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
        }
        if (id === 'clock-bg-color') {
          document.querySelectorAll('#clock-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
        }
        if (id === 'notify-bg-color') {
          document.querySelectorAll('#notify-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
        }
        packAndSavePreferences(false);
      });
    }
  });

  // Color presets click handler
  document.querySelectorAll('#timer-bg-presets .color-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      document.querySelectorAll('#timer-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const selectedColor = e.currentTarget.getAttribute('data-color');
      document.getElementById('timer-bg-color').value = selectedColor;
      packAndSavePreferences(false);
    });
  });

  // Clock Color presets click handler
  document.querySelectorAll('#clock-bg-presets .color-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      document.querySelectorAll('#clock-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const selectedColor = e.currentTarget.getAttribute('data-color');
      document.getElementById('clock-bg-color').value = selectedColor;
      packAndSavePreferences(false);
    });
  });

  // Notice board Color presets click handler
  document.querySelectorAll('#notify-bg-presets .color-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      document.querySelectorAll('#notify-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
      e.currentTarget.classList.add('active');
      const selectedColor = e.currentTarget.getAttribute('data-color');
      document.getElementById('notify-bg-color').value = selectedColor;
      packAndSavePreferences(false);
    });
  });

  // Clock Font selector grid click handler
  const clockFontGrid = document.getElementById('clock-font-grid');
  if (clockFontGrid) {
    clockFontGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.font-chip');
      if (chip) {
        clockFontGrid.querySelectorAll('.font-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preferences.clock.fontFamily = chip.getAttribute('data-font');
        packAndSavePreferences(false);
      }
    });
  }

  // Clock Theme selector grid click handler
  const clockThemeGrid = document.getElementById('clock-theme-grid');
  if (clockThemeGrid) {
    clockThemeGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.theme-chip');
      if (chip) {
        clockThemeGrid.querySelectorAll('.theme-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const themeName = chip.getAttribute('data-theme');
        state.preferences.clock.theme = themeName;
        // Auto update bg color for clock if theme is selected to maintain consistency
        const defaultBgColors = { blue: '#030715', gold: '#110d05', rose: '#140a0b' };
        state.preferences.clock.bgColor = defaultBgColors[themeName] || '#030715';
        const clockBgColorInput = document.getElementById('clock-bg-color');
        if (clockBgColorInput) clockBgColorInput.value = state.preferences.clock.bgColor;
        document.querySelectorAll('#clock-bg-presets .color-chip').forEach(c => c.classList.remove('active'));
        packAndSavePreferences(false);
      }
    });
  }

  // NDI Timer Font Face click handler
  const ndiTimerFontGrid = document.getElementById('ndi-timer-font-grid');
  if (ndiTimerFontGrid) {
    ndiTimerFontGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.font-chip');
      if (chip) {
        ndiTimerFontGrid.querySelectorAll('.font-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preferences.ndi.timerFontFamily = chip.getAttribute('data-font');
        packAndSavePreferences(false);
      }
    });
  }

  // Save preferences action (Now functions as unified modal closer)
  document.getElementById('btn-save-settings').addEventListener('click', () => {
    packAndSavePreferences(true);
  });
  
  // 💡 기동 시 로드된 이전 설정을 오버레이 윈도우에 즉시 동적 주입 및 노출 제어
  updateOverlayWindowVisibility();
  syncTimerWithOverlay(true, true);
});

// Setup NDI specific interactive 3x3 positions grid UI
function setupNdiPosGrid(gridId, propertyName) {
  const grid = document.getElementById(gridId);
  if (grid) {
    grid.addEventListener('click', (e) => {
      if (e.target.classList.contains('grid-cell')) {
        grid.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        const pos = e.target.getAttribute('data-pos');
        if (!state.preferences.ndi) state.preferences.ndi = {};
        state.preferences.ndi[propertyName] = pos;
        packAndSavePreferences(false, false, true); // 💡 즉각 반응 지원!
      }
    });
  }
}

// Setup custom interactive 3x3 positions grid UI (with immediate response trigger)
function setupPosGrid(gridId, prefKey) {
  const grid = document.getElementById(gridId);
  grid.addEventListener('click', (e) => {
    if (e.target.classList.contains('grid-cell')) {
      grid.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('active'));
      e.target.classList.add('active');
      const pos = e.target.getAttribute('data-pos');
      state.preferences[prefKey].position = pos;
      packAndSavePreferences(false, false, true);
    }
  });
}

function syncPrefUIState() {
  // Sync positions grids
  selectGridCell('timer-position-grid', state.preferences.timer.position);
  selectGridCell('clock-position-grid', state.preferences.clock.position);
  selectGridCell('notify-position-grid', state.preferences.notify.position);
  
  // Sync Background Color Custom Picker & Preset Chips
  const bgColor = state.preferences.timer.bgColor || '#0a0f1a';
  document.getElementById('timer-bg-color').value = bgColor;
  
  document.querySelectorAll('#timer-bg-presets .color-chip').forEach(chip => {
    if (chip.getAttribute('data-color').toLowerCase() === bgColor.toLowerCase()) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync Clock Background Color Custom Picker & Preset Chips
  const clockBgColor = state.preferences.clock.bgColor || '#030715';
  document.getElementById('clock-bg-color').value = clockBgColor;
  
  document.querySelectorAll('#clock-bg-presets .color-chip').forEach(chip => {
    if (chip.getAttribute('data-color').toLowerCase() === clockBgColor.toLowerCase()) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync Notice Board Background Color Custom Picker & Preset Chips
  const notifyBgColor = state.preferences.notify.bgColor || '#0a0f1a';
  document.getElementById('notify-bg-color').value = notifyBgColor;
  
  document.querySelectorAll('#notify-bg-presets .color-chip').forEach(chip => {
    if (chip.getAttribute('data-color').toLowerCase() === notifyBgColor.toLowerCase()) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync sliders
  setSliderVal('timer-font-size', 'lbl-timer-font-size', state.preferences.timer.fontSize !== undefined ? state.preferences.timer.fontSize : 45);
  setSliderVal('clock-font-size', 'lbl-clock-font-size', state.preferences.clock.fontSize !== undefined ? state.preferences.clock.fontSize : 40);
  
  // Sync timer font family grid active chip
  const currentFont = state.preferences.timer.fontFamily || 'Outfit';
  document.querySelectorAll('#timer-font-grid .font-chip').forEach(chip => {
    if (chip.getAttribute('data-font') === currentFont) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync clock font family grid active chip
  const currentClockFont = state.preferences.clock.fontFamily || 'Outfit';
  document.querySelectorAll('#clock-font-grid .font-chip').forEach(chip => {
    if (chip.getAttribute('data-font') === currentClockFont) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync premium theme grid active chip
  const currentTheme = state.preferences.timer.theme || 'blue';
  document.querySelectorAll('#timer-theme-grid .theme-chip').forEach(chip => {
    if (chip.getAttribute('data-theme') === currentTheme) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Sync clock premium theme grid active chip
  const currentClockTheme = state.preferences.clock.theme || 'blue';
  document.querySelectorAll('#clock-theme-grid .theme-chip').forEach(chip => {
    if (chip.getAttribute('data-theme') === currentClockTheme) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  setSliderVal('timer-bg-opacity', 'lbl-timer-bg-opacity', state.preferences.timer.bgOpacity !== undefined ? state.preferences.timer.bgOpacity : 68);
  setSliderVal('clock-bg-opacity', 'lbl-clock-bg-opacity', state.preferences.clock.bgOpacity !== undefined ? state.preferences.clock.bgOpacity : 68);
  setSliderVal('notify-scale', 'lbl-notify-scale', state.preferences.notify.scale);
  setSliderVal('notify-bg-opacity', 'lbl-notify-bg-opacity', state.preferences.notify.bgOpacity);
  setSliderVal('chime-volume', 'lbl-chime-volume', state.preferences.chime.volume);
  
  // Sync offset inputs
  document.getElementById('timer-offset-x').value = state.preferences.timer.offsetX;
  document.getElementById('timer-offset-y').value = state.preferences.timer.offsetY;
  document.getElementById('clock-offset-x').value = state.preferences.clock.offsetX !== undefined ? state.preferences.clock.offsetX : 20;
  document.getElementById('clock-offset-y').value = state.preferences.clock.offsetY !== undefined ? state.preferences.clock.offsetY : 20;
  document.getElementById('notify-offset-x').value = state.preferences.notify.offsetX !== undefined ? state.preferences.notify.offsetX : 20;
  document.getElementById('notify-offset-y').value = state.preferences.notify.offsetY !== undefined ? state.preferences.notify.offsetY : 20;
  
  const clickthroughChk = document.getElementById('chk-overlay-clickthrough');
  if (clickthroughChk) {
    clickthroughChk.checked = state.preferences.timer.clickthrough !== undefined ? !!state.preferences.timer.clickthrough : true;
  }
  
  // Sync independent overlay layer toggles
  const chkOverlayTimer = document.getElementById('chk-overlay-timer');
  if (chkOverlayTimer) chkOverlayTimer.checked = !!state.preferences.timer.visible;
  
  const chkOverlayClock = document.getElementById('chk-overlay-clock');
  if (chkOverlayClock) chkOverlayClock.checked = !!state.preferences.clock.visible;
  
  const chkOverlayNotice = document.getElementById('chk-overlay-notice');
  if (chkOverlayNotice) chkOverlayNotice.checked = !!state.preferences.notify.visible;
  
  // Sync checkboxes and details
  document.getElementById('chk-clock-24h').checked = state.preferences.clock.is24h !== undefined ? !!state.preferences.clock.is24h : true;
  document.getElementById('chk-clock-seconds').checked = state.preferences.clock.showSeconds !== undefined ? !!state.preferences.clock.showSeconds : true;
  document.getElementById('chk-notify-blur').checked = state.preferences.notify.blur;
  
  // Sync NDI settings
  const inputNdiName = document.getElementById('input-ndi-name');
  if (inputNdiName) inputNdiName.value = state.preferences.ndi?.sourceName || 'Presentation Timer';
  
  const selectNdiRes = document.getElementById('select-ndi-resolution');
  if (selectNdiRes) selectNdiRes.value = state.preferences.ndi?.resolution || '1280x720';
  
  const selectNdiFps = document.getElementById('select-ndi-fps');
  if (selectNdiFps) selectNdiFps.value = String(state.preferences.ndi?.fps || 30);
  
  // Sync NDI Dedicated Layout Configs
  const ndiPrefs = state.preferences.ndi || {};
  const chkNdiTimerVisible = document.getElementById('checkbox-ndi-timer-visible');
  if (chkNdiTimerVisible) chkNdiTimerVisible.checked = !!ndiPrefs.timerVisible;
  
  const chkNdiAlphaEnabled = document.getElementById('checkbox-ndi-alpha-enabled');
  if (chkNdiAlphaEnabled) chkNdiAlphaEnabled.checked = ndiPrefs.alphaKeyEnabled !== false;
  
  const chkNdiClockVisible = document.getElementById('checkbox-ndi-clock-visible');
  if (chkNdiClockVisible) chkNdiClockVisible.checked = !!ndiPrefs.clockVisible;
  
  const inputNdiTimerSize = document.getElementById('input-ndi-timer-size');
  if (inputNdiTimerSize) {
    setSliderAndNumVal('input-ndi-timer-size', 'input-ndi-timer-size-num', ndiPrefs.timerFontSize !== undefined ? ndiPrefs.timerFontSize : 45);
  }
  
  const inputNdiClockSize = document.getElementById('input-ndi-clock-size');
  if (inputNdiClockSize) {
    setSliderAndNumVal('input-ndi-clock-size', 'input-ndi-clock-size-num', ndiPrefs.clockFontSize !== undefined ? ndiPrefs.clockFontSize : 40);
  }
  
  const ndiTimerFont = ndiPrefs.timerFontFamily || 'Outfit';
  document.querySelectorAll('#ndi-timer-font-grid .font-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-font') === ndiTimerFont);
  });
  
  selectGridCell('ndi-timer-position-grid', ndiPrefs.timerPosition || 'top-right');
  selectGridCell('ndi-clock-position-grid', ndiPrefs.clockPosition || 'top-left');

  updateNdiUI();
  
  const enableWarning = state.preferences.chime.enableWarning;
  document.getElementById('chk-chime-warning').checked = enableWarning;
  document.getElementById('input-chime-warning-time').value = state.preferences.chime.warningTime;
  document.getElementById('select-chime-warning-sound').value = state.preferences.chime.warningSound || 'synth';
  document.getElementById('color-chime-warning-color').value = state.preferences.chime.warningColor || '#eab308';
  document.getElementById('chk-chime-warning-blink').checked = !!state.preferences.chime.warningBlink;
  document.getElementById('chime-warning-details').classList.toggle('disabled', !enableWarning);

  const enableTension = state.preferences.chime.enableTension;
  document.getElementById('chk-chime-tension').checked = enableTension;
  document.getElementById('input-chime-tension-time').value = state.preferences.chime.tensionTime;
  document.getElementById('select-chime-tension-sound').value = state.preferences.chime.tensionSound || 'synth';
  document.getElementById('color-chime-tension-color').value = state.preferences.chime.tensionColor || '#f97316';
  document.getElementById('chk-chime-tension-blink').checked = !!state.preferences.chime.tensionBlink;
  document.getElementById('chime-tension-details').classList.toggle('disabled', !enableTension);

  const enableUrgent = state.preferences.chime.enableUrgent;
  document.getElementById('chk-chime-urgent').checked = enableUrgent;
  document.getElementById('input-chime-urgent-time').value = state.preferences.chime.urgentTime;
  document.getElementById('select-chime-urgent-sound').value = state.preferences.chime.urgentSound || 'synth';
  document.getElementById('color-chime-urgent-color').value = state.preferences.chime.urgentColor || '#ef4444';
  document.getElementById('chk-chime-urgent-blink').checked = !!state.preferences.chime.urgentBlink;
  document.getElementById('chime-urgent-details').classList.toggle('disabled', !enableUrgent);

  // Sync Web Viewer Settings
  const webPrefs = state.preferences.web || {};
  
  const chkWebEnabled = document.getElementById('checkbox-web-enabled');
  if (chkWebEnabled) {
    chkWebEnabled.checked = !!webPrefs.enabled;
  }
  
  const btnWebThemeDark = document.getElementById('btn-web-theme-dark');
  const btnWebThemeTransparent = document.getElementById('btn-web-theme-transparent');
  if (btnWebThemeDark && btnWebThemeTransparent) {
    const isTransparent = webPrefs.theme === 'transparent';
    btnWebThemeDark.classList.toggle('active', !isTransparent);
    btnWebThemeTransparent.classList.toggle('active', isTransparent);
  }
  
  const inputWebSize = document.getElementById('input-web-size');
  if (inputWebSize) {
    setSliderAndNumVal('input-web-size', 'input-web-size-num', webPrefs.fontSize !== undefined ? webPrefs.fontSize : 300);
  }
  
  const webFont = webPrefs.fontFamily || 'Outfit';
  document.querySelectorAll('#web-font-grid .font-chip').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-font') === webFont);
  });
  
  const webColor = webPrefs.textColor || '#ffffff';
  let matchedPreset = false;
  document.querySelectorAll('#web-color-presets .color-chip').forEach(chip => {
    if (chip.id === 'btn-web-custom-color') return;
    const isMatch = chip.getAttribute('data-color').toLowerCase() === webColor.toLowerCase();
    chip.classList.toggle('active', isMatch);
    if (isMatch) matchedPreset = true;
  });
  
  const colorWebCustom = document.getElementById('color-web-custom');
  const btnWebCustomColor = document.getElementById('btn-web-custom-color');
  if (colorWebCustom && btnWebCustomColor) {
    colorWebCustom.value = webColor;
    if (!matchedPreset) {
      btnWebCustomColor.style.background = webColor;
      btnWebCustomColor.classList.add('active');
    } else {
      btnWebCustomColor.style.background = 'linear-gradient(45deg, red, orange, yellow, green, blue, purple)';
      btnWebCustomColor.classList.remove('active');
    }
  }
}

function selectGridCell(gridId, pos) {
  const grid = document.getElementById(gridId);
  grid.querySelectorAll('.grid-cell').forEach(c => {
    if (c.getAttribute('data-pos') === pos) {
      c.classList.add('active');
    } else {
      c.classList.remove('active');
    }
  });
}

function bindSliderLabel(sliderId, labelId) {
  const slider = document.getElementById(sliderId);
  const label = document.getElementById(labelId);
  slider.addEventListener('input', (e) => {
    label.textContent = e.target.value;
  });
}

function bindSliderAndNumInput(sliderId, numInputId) {
  const slider = document.getElementById(sliderId);
  const numInput = document.getElementById(numInputId);
  if (!slider || !numInput) return;
  
  slider.addEventListener('input', (e) => {
    numInput.value = e.target.value;
  });
  
  numInput.addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) return;
    val = Math.max(parseInt(numInput.min) || 20, Math.min(parseInt(numInput.max) || 3000, val));
    slider.value = val;
  });

  numInput.addEventListener('blur', (e) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) {
      numInput.value = slider.value;
      return;
    }
    val = Math.max(parseInt(numInput.min) || 20, Math.min(parseInt(numInput.max) || 3000, val));
    numInput.value = val;
    slider.value = val;
    packAndSavePreferences(false);
  });
}

function setSliderVal(sliderId, labelId, val) {
  document.getElementById(sliderId).value = val;
  document.getElementById(labelId).textContent = val;
}

function setSliderAndNumVal(sliderId, numInputId, val) {
  const slider = document.getElementById(sliderId);
  const numInput = document.getElementById(numInputId);
  if (slider) slider.value = val;
  if (numInput) numInput.value = val;
}

// Packs current DOM input values, updates state, saves to storage, and syncs overlays
function packAndSavePreferences(closeDialog = false, resizeWindow = false, immediate = false) {
  state.preferences.timer.fontSize = parseInt(document.getElementById('timer-font-size').value) || 45;
  const activeFontChip = document.querySelector('#timer-font-grid .font-chip.active');
  state.preferences.timer.fontFamily = activeFontChip ? activeFontChip.getAttribute('data-font') : 'Outfit';
  const activeThemeChip = document.querySelector('#timer-theme-grid .theme-chip.active');
  state.preferences.timer.theme = activeThemeChip ? activeThemeChip.getAttribute('data-theme') : 'blue';
  state.preferences.timer.bgOpacity = parseInt(document.getElementById('timer-bg-opacity').value) || 68;
  state.preferences.timer.offsetX = parseInt(document.getElementById('timer-offset-x').value) || 0;
  state.preferences.timer.offsetY = parseInt(document.getElementById('timer-offset-y').value) || 0;
  state.preferences.timer.bgColor = document.getElementById('timer-bg-color').value;
  
  const clickthroughChk = document.getElementById('chk-overlay-clickthrough');
  if (clickthroughChk) {
    state.preferences.timer.clickthrough = clickthroughChk.checked;
  }
  
  state.preferences.clock.fontSize = parseInt(document.getElementById('clock-font-size').value) || 40;
  const activeClockFontChip = document.querySelector('#clock-font-grid .font-chip.active');
  state.preferences.clock.fontFamily = activeClockFontChip ? activeClockFontChip.getAttribute('data-font') : 'Outfit';
  const activeClockThemeChip = document.querySelector('#clock-theme-grid .theme-chip.active');
  state.preferences.clock.theme = activeClockThemeChip ? activeClockThemeChip.getAttribute('data-theme') : 'blue';
  state.preferences.clock.bgOpacity = parseInt(document.getElementById('clock-bg-opacity').value) || 68;
  state.preferences.clock.offsetX = parseInt(document.getElementById('clock-offset-x').value) || 0;
  state.preferences.clock.offsetY = parseInt(document.getElementById('clock-offset-y').value) || 0;
  state.preferences.clock.bgColor = document.getElementById('clock-bg-color').value;
  state.preferences.clock.is24h = document.getElementById('chk-clock-24h').checked;
  state.preferences.clock.showSeconds = document.getElementById('chk-clock-seconds').checked;

  state.preferences.notify.scale = parseFloat(document.getElementById('notify-scale').value);
  state.preferences.notify.blur = document.getElementById('chk-notify-blur').checked;
  state.preferences.notify.bgOpacity = parseInt(document.getElementById('notify-bg-opacity').value);
  state.preferences.notify.offsetX = parseInt(document.getElementById('notify-offset-x').value) || 0;
  state.preferences.notify.offsetY = parseInt(document.getElementById('notify-offset-y').value) || 0;
  state.preferences.notify.bgColor = document.getElementById('notify-bg-color').value;
  
  state.preferences.chime.enableWarning = document.getElementById('chk-chime-warning').checked;
  state.preferences.chime.warningTime = parseInt(document.getElementById('input-chime-warning-time').value) || 0;
  state.preferences.chime.warningSound = document.getElementById('select-chime-warning-sound').value;
  state.preferences.chime.warningColor = document.getElementById('color-chime-warning-color').value;
  state.preferences.chime.warningBlink = document.getElementById('chk-chime-warning-blink').checked;

  state.preferences.chime.enableTension = document.getElementById('chk-chime-tension').checked;
  state.preferences.chime.tensionTime = parseInt(document.getElementById('input-chime-tension-time').value) || 0;
  state.preferences.chime.tensionSound = document.getElementById('select-chime-tension-sound').value;
  state.preferences.chime.tensionColor = document.getElementById('color-chime-tension-color').value;
  state.preferences.chime.tensionBlink = document.getElementById('chk-chime-tension-blink').checked;

  state.preferences.chime.enableUrgent = document.getElementById('chk-chime-urgent').checked;
  state.preferences.chime.urgentTime = parseInt(document.getElementById('input-chime-urgent-time').value) || 0;
  state.preferences.chime.urgentSound = document.getElementById('select-chime-urgent-sound').value;
  state.preferences.chime.urgentColor = document.getElementById('color-chime-urgent-color').value;
  state.preferences.chime.urgentBlink = document.getElementById('chk-chime-urgent-blink').checked;

  state.preferences.chime.volume = parseInt(document.getElementById('chime-volume').value);
  
  // Pack NDI Configuration settings
  if (!state.preferences.ndi) {
    state.preferences.ndi = {};
  }
  state.preferences.ndi.sourceName = document.getElementById('input-ndi-name')?.value || 'Presentation Timer';
  state.preferences.ndi.resolution = document.getElementById('select-ndi-resolution')?.value || '1280x720';
  state.preferences.ndi.fps = parseInt(document.getElementById('select-ndi-fps')?.value) || 30;

  const chkNdiTimerVisible = document.getElementById('checkbox-ndi-timer-visible');
  if (chkNdiTimerVisible) {
    state.preferences.ndi.timerVisible = chkNdiTimerVisible.checked;
  }
  const chkNdiAlphaEnabled = document.getElementById('checkbox-ndi-alpha-enabled');
  if (chkNdiAlphaEnabled) {
    state.preferences.ndi.alphaKeyEnabled = chkNdiAlphaEnabled.checked;
  }
  const inputNdiTimerSize = document.getElementById('input-ndi-timer-size');
  if (inputNdiTimerSize) {
    state.preferences.ndi.timerFontSize = parseInt(inputNdiTimerSize.value) || 45;
  }
  const activeNdiTimerFont = document.querySelector('#ndi-timer-font-grid .font-chip.active');
  if (activeNdiTimerFont) {
    state.preferences.ndi.timerFontFamily = activeNdiTimerFont.getAttribute('data-font');
  }
  const activeNdiTimerPos = document.querySelector('#ndi-timer-position-grid .grid-cell.active');
  if (activeNdiTimerPos) {
    state.preferences.ndi.timerPosition = activeNdiTimerPos.getAttribute('data-pos');
  }

  const chkNdiClockVisible = document.getElementById('checkbox-ndi-clock-visible');
  if (chkNdiClockVisible) {
    state.preferences.ndi.clockVisible = chkNdiClockVisible.checked;
  }
  const inputNdiClockSize = document.getElementById('input-ndi-clock-size');
  if (inputNdiClockSize) {
    state.preferences.ndi.clockFontSize = parseInt(inputNdiClockSize.value) || 40;
  }
  const activeNdiClockPos = document.querySelector('#ndi-clock-position-grid .grid-cell.active');
  if (activeNdiClockPos) {
    state.preferences.ndi.clockPosition = activeNdiClockPos.getAttribute('data-pos');
  }
  
  // Real-time update detail panels interactive styling (disabled class toggle)
  document.getElementById('chime-warning-details').classList.toggle('disabled', !state.preferences.chime.enableWarning);
  document.getElementById('chime-tension-details').classList.toggle('disabled', !state.preferences.chime.enableTension);
  document.getElementById('chime-urgent-details').classList.toggle('disabled', !state.preferences.chime.enableUrgent);

  // Pack Web Overlay Configuration settings
  if (!state.preferences.web) {
    state.preferences.web = {};
  }
  const chkWebEnabled = document.getElementById('checkbox-web-enabled');
  if (chkWebEnabled) {
    state.preferences.web.enabled = chkWebEnabled.checked;
  }
  const activeWebThemeBtn = document.querySelector('#btn-web-theme-transparent.active') || document.querySelector('#btn-web-theme-dark.active');
  if (activeWebThemeBtn) {
    state.preferences.web.theme = activeWebThemeBtn.getAttribute('data-theme') || 'dark';
  }
  const inputWebSize = document.getElementById('input-web-size');
  if (inputWebSize) {
    state.preferences.web.fontSize = parseInt(inputWebSize.value) || 300;
  }
  const activeWebFont = document.querySelector('#web-font-grid .font-chip.active');
  if (activeWebFont) {
    state.preferences.web.fontFamily = activeWebFont.getAttribute('data-font');
  }
  const activeWebColorChip = document.querySelector('#web-color-presets .color-chip.active');
  if (activeWebColorChip) {
    if (activeWebColorChip.id === 'btn-web-custom-color') {
      state.preferences.web.textColor = document.getElementById('color-web-custom').value;
    } else {
      state.preferences.web.textColor = activeWebColorChip.getAttribute('data-color');
    }
  }

  savePreferences(immediate);
  
  // Real-time update main timer state (colors, blink animation)
  renderTimerUI();
  
  // Fit window layout to content dynamically only if explicitly requested
  if (resizeWindow) {
    fitMainWindowToContent();
  }
  
  if (closeDialog) {
    document.getElementById('settings-dialog').close();
    // Sync size on closing dialog window to prevent layout truncation
    fitMainWindowToContent();
  }
}

