/* Premium Presentation Timer - Overlay Window Script (overlay.js)
   Engineered with Tauri v2 IPC listeners, 3x3 layout grid snap teleport, and HSL custom property variables. */

let hasTauri = false;
let cachedPreferences = null;
let lastOverlayData = null;

// DOM Cache
let timerEl = null;
let timerTextEl = null;
let clockEl = null;
let clockTextEl = null;
let noticeEl = null;
let noticeTextEl = null;

// Track active placements to avoid redundant DOM operations
let currentTimerPosition = '';
let currentClockPosition = '';
let currentNoticePosition = '';

// Drag and Drop State Cache
let isDragging = false;
let dragTarget = null;
let startX = 0, startY = 0;
let startOffsetX = 0, startOffsetY = 0;
let lastClickthroughPref = true;

// Offsets Cache for 3x3 Snapping Reverse Calculation
let lastTimerOffsetX = 20;
let lastTimerOffsetY = 20;
let lastClockOffsetX = 20;
let lastClockOffsetY = 20;
let lastNoticeOffsetX = 20;
let lastNoticeOffsetY = 20;

// Mouse Hover Tracking for Smart Clickthrough
let isMouseOverTimer = false;
let isMouseOverClock = false;
let isMouseOverNotice = false;

// Local clock settings cache
let clock24h = true;
let clockShowSeconds = true;

window.addEventListener('DOMContentLoaded', () => {
  timerEl = document.getElementById('overlay-timer');
  timerTextEl = document.getElementById('overlay-timer-text');
  clockEl = document.getElementById('overlay-clock');
  clockTextEl = document.getElementById('overlay-clock-text');
  noticeEl = document.getElementById('overlay-notice');
  noticeTextEl = document.getElementById('overlay-notice-text');
  
  // Smart Clickthrough Hover Engine Wire-up
  timerEl.addEventListener('mouseenter', () => {
    isMouseOverTimer = true;
    updateClickthroughState();
  });
  
  timerEl.addEventListener('mouseleave', () => {
    isMouseOverTimer = false;
    updateClickthroughState();
  });

  clockEl.addEventListener('mouseenter', () => {
    isMouseOverClock = true;
    updateClickthroughState();
  });
  
  clockEl.addEventListener('mouseleave', () => {
    isMouseOverClock = false;
    updateClickthroughState();
  });
  
  noticeEl.addEventListener('mouseenter', () => {
    isMouseOverNotice = true;
    updateClickthroughState();
  });
  
  noticeEl.addEventListener('mouseleave', () => {
    isMouseOverNotice = false;
    updateClickthroughState();
  });
  
  // Initiate Drag triggers
  timerEl.addEventListener('mousedown', (e) => {
    // Bypass if clickthrough is ON (Pure presentation overlay mode)
    if (lastClickthroughPref === true) return;
    e.preventDefault();
    initiateDrag(e, 'timer', timerEl);
  });

  clockEl.addEventListener('mousedown', (e) => {
    if (lastClickthroughPref === true) return;
    e.preventDefault();
    initiateDrag(e, 'clock', clockEl);
  });
  
  noticeEl.addEventListener('mousedown', (e) => {
    if (lastClickthroughPref === true) return;
    e.preventDefault();
    initiateDrag(e, 'notice', noticeEl);
  });

  // Start independent local 1s clock tick loop
  setInterval(updateLocalClockTime, 1000);
  updateLocalClockTime();
  
  // Escape key handler to deactivate overlay from overlay scope
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (hasTauri) {
        window.__TAURI__.core.invoke('set_overlay_visible', { visible: false }).catch(err => console.error(err));
      } else {
        console.log("[Tauri Mock] Escape pressed - hiding overlay Standalone");
      }
    }
  });
  
  // Poll for window.__TAURI__ to avoid race conditions with Tauri's bootstrapper script injection
  let attempts = 0;
  const maxAttempts = 100; // 5 seconds (50ms * 100)
  const interval = setInterval(() => {
    attempts++;
    if (typeof window !== 'undefined' && window.__TAURI__ !== undefined) {
      clearInterval(interval);
      hasTauri = true;
      console.log(`[Overlay] Tauri API successfully detected after ${attempts} attempts`);
      
      const { listen } = window.__TAURI__.event;
      
      // Listen for live ticks and setting updates from the main panel
      listen('timer-state-update', (event) => {
        try {
          const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          updateOverlayState(payload);
        } catch (err) {
          console.error("Failed parsing timer payload: ", err);
        }
      });
      
      // Initial clickthrough policy sync
      updateClickthroughState();
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      console.log("[Overlay] Tauri API not detected, running in Standalone/Mock mode");
      
      // Fallback: Mock web loop for testing layout standalone
      window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'timer-state-update') {
          updateOverlayState(e.data.payload);
        }
      });
    }
  }, 50);
});

// Smart Clickthrough Control Engine
function updateClickthroughState() {
  if (!hasTauri) return;
  
  // lastClickthroughPref가 true(관통 모드)일 때만 마우스 완전 관통 설정
  const clickthrough = (lastClickthroughPref === true);
  window.__TAURI__.core.invoke('set_overlay_clickthrough', { clickthrough }).catch(err => console.error(err));
}


// 60FPS Hybrid Drag and Drop Handler
function initiateDrag(e, type, el) {
  isDragging = true;
  dragTarget = el;
  startX = e.clientX;
  startY = e.clientY;
  
  if (type === 'timer') {
    startOffsetX = lastTimerOffsetX;
    startOffsetY = lastTimerOffsetY;
  } else if (type === 'clock') {
    startOffsetX = lastClockOffsetX;
    startOffsetY = lastClockOffsetY;
  } else {
    startOffsetX = lastNoticeOffsetX;
    startOffsetY = lastNoticeOffsetY;
  }
  
  el.classList.add('dragging');
  document.body.classList.add('dragging-active');
  updateClickthroughState();
  
  // Capture initial compute transform values
  const style = window.getComputedStyle(el);
  const matrix = new DOMMatrixReadOnly(style.transform);
  const startTX = matrix.m41;
  const startTY = matrix.m42;
  
  const onMouseMove = (moveEvt) => {
    if (!isDragging) return;
    const diffX = moveEvt.clientX - startX;
    const diffY = moveEvt.clientY - startY;
    
    // Apply immediate local CSS transform changes for 60fps smooth rendering
    el.style.transform = `translate(${startTX + diffX}px, ${startTY + diffY}px)`;
  };
  
  const onMouseUp = (upEvt) => {
    isDragging = false;
    el.classList.remove('dragging');
    document.body.classList.remove('dragging-active');
    
    const diffX = upEvt.clientX - startX;
    const diffY = upEvt.clientY - startY;
    
    // Perform reverse-calculation of offset values based on 3x3 snapper alignment
    let finalOffsetX = startOffsetX;
    let finalOffsetY = startOffsetY;
    let pos = '';
    if (type === 'timer') {
      pos = currentTimerPosition;
    } else if (type === 'clock') {
      pos = currentClockPosition;
    } else {
      pos = currentNoticePosition;
    }
    
    if (pos.includes('right')) {
      finalOffsetX = startOffsetX - diffX;
    } else if (pos.includes('left') || pos.includes('center')) {
      finalOffsetX = startOffsetX + diffX;
    }
    
    if (pos.includes('bottom')) {
      finalOffsetY = startOffsetY - diffY;
    } else if (pos.includes('top') || pos.includes('center-')) {
      finalOffsetY = startOffsetY + diffY;
    }
    
    // Guard against negative boundaries
    finalOffsetX = Math.max(0, finalOffsetX);
    finalOffsetY = Math.max(0, finalOffsetY);
    
    if (type === 'timer') {
      lastTimerOffsetX = finalOffsetX;
      lastTimerOffsetY = finalOffsetY;
    } else if (type === 'clock') {
      lastClockOffsetX = finalOffsetX;
      lastClockOffsetY = finalOffsetY;
    } else {
      lastNoticeOffsetX = finalOffsetX;
      lastNoticeOffsetY = finalOffsetY;
    }
    
    // Send single final coordinate packet to main panel to update inputs and save
    if (hasTauri) {
      window.__TAURI__.event.emit('overlay-dragged', {
        type: type,
        offsetX: finalOffsetX,
        offsetY: finalOffsetY
      }).catch(err => console.error(err));
    } else {
      console.log(`[Tauri Mock] overlay-dragged emitted:`, { type, offsetX: finalOffsetX, offsetY: finalOffsetY });
    }
    
    // Remove temporary inline drag styling to let CSS variables take full control
    el.style.transform = '';
    
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    updateClickthroughState();
  };
  
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

const defaultPreferences = {
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
  }
};

function updateOverlayState(data) {
  if (!data) return;
  
  // Cache and preserve preferences across continuous minimal 60FPS IPC ticks
  if (data.preferences) {
    cachedPreferences = data.preferences;
  }
  
  // Inject cached/default preferences back into data to ensure all down-stream logic gets full configurations
  data.preferences = cachedPreferences || defaultPreferences;
  lastOverlayData = data; // Cache for NDI render loop
  
  const { remaining, duration, isRunning, announcement, preferences } = data;
  
  // Sync local clock format variables instantly
  if (preferences?.clock) {
    clock24h = preferences.clock.is24h !== undefined ? preferences.clock.is24h : true;
    clockShowSeconds = preferences.clock.showSeconds !== undefined ? preferences.clock.showSeconds : true;
  }
  
  // Apply visual theme to overlay body dynamically
  const currentTheme = preferences?.timer?.theme || 'blue';
  document.body.classList.remove('theme-blue', 'theme-gold', 'theme-rose');
  document.body.classList.add(`theme-${currentTheme}`);
  
  // Live clickthrough settings sync
  const currentClickthrough = preferences?.timer?.clickthrough !== undefined ? preferences.timer.clickthrough : true;
  if (currentClickthrough !== lastClickthroughPref) {
    lastClickthroughPref = currentClickthrough;
    updateClickthroughState();
  }
  
  // Grabbing cursor visual clues and edit mode state
  if (lastClickthroughPref === false) {
    timerEl.classList.add('interactive-mode');
    noticeEl.classList.add('interactive-mode');
    clockEl.classList.add('interactive-mode');
    document.body.classList.add('edit-mode-active');
  } else {
    timerEl.classList.remove('interactive-mode');
    noticeEl.classList.remove('interactive-mode');
    clockEl.classList.remove('interactive-mode');
    document.body.classList.remove('edit-mode-active');
  }
  
  // 1. Render Clock Timer
  const isOvertime = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const m = Math.floor(absRemaining / 60);
  const s = Math.floor(absRemaining % 60);
  
  const minutesStr = String(m).padStart(2, '0');
  const secondsStr = String(s).padStart(2, '0');
  
  // Dynamic tick text
  timerTextEl.textContent = `${isOvertime ? '-' : ''}${minutesStr}:${secondsStr}`;
  
  // Toggle status class
  timerEl.className = 'overlay-timer';
  if (lastClickthroughPref === false) {
    timerEl.classList.add('interactive-mode');
    if (isDragging && dragTarget === timerEl) {
      timerEl.classList.add('dragging');
    }
  }
  
  if (isOvertime) {
    timerEl.classList.add('state-overtime');
  } else if (isRunning) {
    timerEl.classList.add('state-running');
  } else {
    timerEl.classList.add('state-paused');
  }
  
  // Dynamic background opacity custom styling (excludes text contents)
  const timerOpacity = (preferences?.timer?.bgOpacity !== undefined ? preferences.timer.bgOpacity : 68) / 100;
  const bgColor = preferences?.timer?.bgColor || '#030715';
  const rgb = hexToRgb(bgColor);
  
  // Determine alarm thresholds, colors, and blink settings for overlay sync
  const chimePrefs = preferences?.chime || {};
  const wTime = parseInt(chimePrefs.warningTime) || 60;
  const tTime = parseInt(chimePrefs.tensionTime) || 30;
  const uTime = parseInt(chimePrefs.urgentTime) || 10;
  
  const wColor = chimePrefs.warningColor || '#eab308';
  const tColor = chimePrefs.tensionColor || '#f97316';
  const uColor = chimePrefs.urgentColor || '#ef4444';
  
  const wBlink = !!chimePrefs.warningBlink;
  const tBlink = !!chimePrefs.tensionBlink;
  const uBlink = !!chimePrefs.urgentBlink;
  
  let activeColor = '';
  let activeBlink = false;
  
  if (isOvertime) {
    activeColor = chimePrefs.enableUrgent ? uColor : 'var(--accent-danger)';
    activeBlink = chimePrefs.enableUrgent ? uBlink : true;
  } else {
    if (chimePrefs.enableUrgent && remaining <= uTime) {
      activeColor = uColor;
      activeBlink = uBlink;
    } else if (chimePrefs.enableTension && remaining <= tTime) {
      activeColor = tColor;
      activeBlink = tBlink;
    } else if (chimePrefs.enableWarning && remaining <= wTime) {
      activeColor = wColor;
      activeBlink = wBlink;
    }
  }

  // Adjust borders and backgrounds for overtime/warning states dynamically
  if (isOvertime) {
    const alertRgb = activeColor.startsWith('#') ? hexToRgb(activeColor) : { r: 239, g: 68, b: 68 };
    const blendedR = Math.min(255, Math.floor(rgb.r * 0.4 + alertRgb.r * 0.6));
    const blendedG = Math.floor(rgb.g * 0.4 + alertRgb.g * 0.1);
    const blendedB = Math.floor(rgb.b * 0.4 + alertRgb.b * 0.1);
    timerEl.style.background = `rgba(${blendedR}, ${blendedG}, ${blendedB}, ${timerOpacity})`;
    timerEl.style.borderColor = activeColor.startsWith('#') ? `${activeColor}55` : 'rgba(239, 68, 68, 0.35)';
  } else {
    timerEl.style.background = hexToRgba(bgColor, timerOpacity);
    const isLightBg = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) > 128;
    timerEl.style.borderColor = isLightBg ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.08)';
  }

  // Auto Contrast logic based on background luminance and opacity
  const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  const useDarkText = (timerOpacity > 0.3) && (luminance > 128);
  
  // Manage custom alert colors and blink animations dynamically
  const dotEl = timerEl.querySelector('.overlay-timer-dot');
  
  if (activeColor) {
    timerTextEl.style.color = activeColor;
    timerTextEl.style.setProperty('--alert-glow-color', activeColor);
    
    if (dotEl) {
      dotEl.style.backgroundColor = activeColor;
      dotEl.style.boxShadow = `0 0 12px ${activeColor}`;
      dotEl.style.setProperty('--alert-glow-color', activeColor);
    }
    
    if (activeBlink && isRunning) {
      timerTextEl.classList.add('blink-active');
      if (dotEl) dotEl.classList.add('blink-active');
    } else {
      timerTextEl.classList.remove('blink-active');
      if (dotEl) dotEl.classList.remove('blink-active');
    }
  } else {
    timerTextEl.classList.remove('blink-active');
    if (dotEl) {
      dotEl.classList.remove('blink-active');
      dotEl.style.backgroundColor = '';
      dotEl.style.boxShadow = '';
    }
    
    if (useDarkText) {
      timerTextEl.style.color = 'rgba(10, 15, 26, 0.95)';
      timerTextEl.style.textShadow = 'none';
    } else {
      timerTextEl.style.color = '';
      timerTextEl.style.textShadow = '';
    }
  }

  // Opacity dynamic blur filter
  const timerBlur = timerOpacity > 0 ? `blur(${timerOpacity * 16}px)` : 'none';
  timerEl.style.backdropFilter = timerBlur;
  timerEl.style.webkitBackdropFilter = timerBlur;
  
  // Independent timer layer visibility
  const timerVisible = preferences?.timer?.visible !== undefined ? preferences.timer.visible : true;
  timerEl.style.display = timerVisible ? 'inline-flex' : 'none';
  
  // 2. Position Timer, Notice, and Clock (Teleport via appendChild if position changed)
  const timerPos = preferences?.timer?.position || 'top-right';
  const noticePos = preferences?.notify?.position || 'bottom-center';
  const clockPos = preferences?.clock?.position || 'top-left';
  
  if (timerPos !== currentTimerPosition) {
    const targetZone = document.getElementById(`zone-${timerPos}`);
    if (targetZone) {
      targetZone.appendChild(timerEl);
      currentTimerPosition = timerPos;
    }
  }
  
  if (noticePos !== currentNoticePosition) {
    const targetZone = document.getElementById(`zone-${noticePos}`);
    if (targetZone) {
      targetZone.appendChild(noticeEl);
      currentNoticePosition = noticePos;
    }
  }

  if (clockPos !== currentClockPosition) {
    const targetZone = document.getElementById(`zone-${clockPos}`);
    if (targetZone) {
      targetZone.appendChild(clockEl);
      currentClockPosition = clockPos;
    }
  }
  
  // 3. Dynamic Styling and Scale transformations
  const timerFontSize = preferences?.timer?.fontSize || 45;
  const timerFontFamily = preferences?.timer?.fontFamily || 'Outfit';
  const timerOffsetX = preferences?.timer?.offsetX || 0;
  const timerOffsetY = preferences?.timer?.offsetY || 0;
  
  // Synchronize cache offsets for drag calculations
  lastTimerOffsetX = timerOffsetX;
  lastTimerOffsetY = timerOffsetY;
  
  // Bypass translate computation if actively dragging timer element (Bypass Rendering Guard)
  if (!isDragging || dragTarget !== timerEl) {
    let tX = timerOffsetX;
    let tY = timerOffsetY;
    
    if (timerPos.includes('right')) tX = -timerOffsetX;
    if (timerPos.includes('center')) tX = 0;
    if (timerPos.includes('bottom')) tY = -timerOffsetY;
    if (timerPos.includes('center-')) tY = 0;
    
    timerEl.style.transform = `translate(${tX}px, ${tY}px)`;
  }
  
  // Apply Font Style directly to timer digits
  timerTextEl.style.fontSize = `${timerFontSize}px`;
  timerTextEl.style.fontFamily = `'${timerFontFamily}', sans-serif`;
  
  // Proportional dot size
  if (dotEl) {
    const dotSize = Math.max(6, Math.min(40, Math.round(timerFontSize * 0.22)));
    dotEl.style.width = `${dotSize}px`;
    dotEl.style.height = `${dotSize}px`;
  }
  
  // Proportional padding & border radius
  const verticalPadding = Math.max(6, Math.round(timerFontSize * 0.26));
  const horizontalPadding = Math.max(10, Math.round(timerFontSize * 0.48));
  timerEl.style.padding = `${verticalPadding}px ${horizontalPadding}px`;
  
  const borderRadius = Math.max(8, Math.round(timerFontSize * 0.35));
  timerEl.style.borderRadius = `${borderRadius}px`;
  
  // === Dynamic Clock Render Engine ===
  const clockVisible = preferences?.clock?.visible !== undefined ? preferences.clock.visible : false;
  clockEl.style.display = clockVisible ? 'inline-flex' : 'none';
  
  // Reset classes for clock to capture correct dragging outline state
  clockEl.className = 'overlay-clock';
  if (lastClickthroughPref === false) {
    clockEl.classList.add('interactive-mode');
    if (isDragging && dragTarget === clockEl) {
      clockEl.classList.add('dragging');
    }
  }

  const clockFontSize = preferences?.clock?.fontSize || 40;
  const clockFontFamily = preferences?.clock?.fontFamily || 'Outfit';
  const clockOffsetX = preferences?.clock?.offsetX !== undefined ? preferences.clock.offsetX : 20;
  const clockOffsetY = preferences?.clock?.offsetY !== undefined ? preferences.clock.offsetY : 20;

  lastClockOffsetX = clockOffsetX;
  lastClockOffsetY = clockOffsetY;

  if (!isDragging || dragTarget !== clockEl) {
    let cX = clockOffsetX;
    let cY = clockOffsetY;
    
    if (clockPos.includes('right')) cX = -clockOffsetX;
    if (clockPos.includes('center')) cX = 0;
    if (clockPos.includes('bottom')) cY = -clockOffsetY;
    if (clockPos.includes('center-')) cY = 0;
    
    clockEl.style.transform = `translate(${cX}px, ${cY}px)`;
  }

  clockTextEl.style.fontSize = `${clockFontSize}px`;
  clockTextEl.style.fontFamily = `'${clockFontFamily}', sans-serif`;

  const cVerticalPadding = Math.max(6, Math.round(clockFontSize * 0.26));
  const cHorizontalPadding = Math.max(10, Math.round(clockFontSize * 0.48));
  clockEl.style.padding = `${cVerticalPadding}px ${cHorizontalPadding}px`;
  
  const cBorderRadius = Math.max(8, Math.round(clockFontSize * 0.35));
  clockEl.style.borderRadius = `${cBorderRadius}px`;

  // Clock background blending and blurring
  const clockOpacity = (preferences?.clock?.bgOpacity !== undefined ? preferences.clock.bgOpacity : 68) / 100;
  const clockBgColor = preferences?.clock?.bgColor || '#030715';
  const clockRgb = hexToRgb(clockBgColor);
  clockEl.style.background = hexToRgba(clockBgColor, clockOpacity);

  const clockBlur = clockOpacity > 0 ? `blur(${clockOpacity * 16}px)` : 'none';
  clockEl.style.backdropFilter = clockBlur;
  clockEl.style.webkitBackdropFilter = clockBlur;

  const clockLuminance = 0.299 * clockRgb.r + 0.587 * clockRgb.g + 0.114 * clockRgb.b;
  const clockUseDarkText = (clockOpacity > 0.3) && (clockLuminance > 128);

  const clockIcon = clockEl.querySelector('.overlay-clock-icon');

  if (clockUseDarkText) {
    clockTextEl.style.color = 'rgba(10, 15, 26, 0.95)';
    if (clockIcon) clockIcon.style.color = 'rgba(10, 15, 26, 0.95)';
    clockEl.style.borderColor = 'rgba(0, 0, 0, 0.15)';
  } else {
    clockTextEl.style.color = '';
    if (clockIcon) clockIcon.style.color = '';
    clockEl.style.borderColor = 'rgba(255, 255, 255, 0.08)';
  }

  // Instantly sync the local time presentation using SSOT clockText or fallback to local precision clock
  if (data.clockText && clockTextEl) {
    clockTextEl.textContent = data.clockText;
  } else {
    updateLocalClockTime();
  }

  // Notice board stylings
  const noticeScale = preferences?.notify?.scale || 1.0;
  const noticeBlur = preferences?.notify?.blur;
  const noticeOpacity = (preferences?.notify?.bgOpacity !== undefined ? preferences.notify.bgOpacity : 80) / 100;
  const noticeOffsetX = preferences?.notify?.offsetX !== undefined ? preferences.notify.offsetX : 20;
  const noticeOffsetY = preferences?.notify?.offsetY !== undefined ? preferences.notify.offsetY : 20;
  const noticeBgColor = preferences?.notify?.bgColor || '#030715';

  // Synchronize cache offsets for notice drag calculations
  lastNoticeOffsetX = noticeOffsetX;
  lastNoticeOffsetY = noticeOffsetY;

  // Bypass translate computation if actively dragging notice element (Bypass Rendering Guard)
  if (!isDragging || dragTarget !== noticeEl) {
    let ntX = noticeOffsetX;
    let ntY = noticeOffsetY;
    
    if (noticePos.includes('right')) ntX = -noticeOffsetX;
    if (noticePos.includes('center')) ntX = 0;
    if (noticePos.includes('bottom')) ntY = -noticeOffsetY;
    if (noticePos.includes('center-')) ntY = 0;
  
    noticeEl.style.setProperty('--offset-x', `${ntX}px`);
    noticeEl.style.setProperty('--offset-y', `${ntY}px`);
  }
  
  // Scale the notice board using font size instead of CSS transform: scale to prevent blurriness
  const noticeBaseFontSize = Math.round(16 * noticeScale);
  noticeEl.style.fontSize = `${noticeBaseFontSize}px`;
  
  // Proportional dynamic padding, borders, gaps, max-width
  const nVerticalPadding = Math.max(6, Math.round(noticeBaseFontSize * 0.85));
  const nHorizontalPadding = Math.max(10, Math.round(noticeBaseFontSize * 1.5));
  noticeEl.style.padding = `${nVerticalPadding}px ${nHorizontalPadding}px`;
  
  const nBorderRadius = Math.max(8, Math.round(noticeBaseFontSize * 1.1));
  noticeEl.style.borderRadius = `${nBorderRadius}px`;
  
  noticeEl.style.gap = `${Math.round(noticeBaseFontSize * 0.85)}px`;
  noticeEl.style.maxWidth = `${Math.round(noticeBaseFontSize * 30)}px`;
  
  // Update inner text and icon sizes proportionally to stay sharp
  const noticeTextElInside = noticeEl.querySelector('.overlay-notice-text');
  const noticeIconElInside = noticeEl.querySelector('.overlay-notice-icon');
  if (noticeTextElInside) {
    noticeTextElInside.style.fontSize = `${noticeBaseFontSize}px`;
  }
  if (noticeIconElInside) {
    noticeIconElInside.style.fontSize = `${Math.round(noticeBaseFontSize * 1.37)}px`;
  }
  
  // Neutralize the CSS transform scale variable to avoid double scaling or blurriness
  noticeEl.style.setProperty('--scale', '1');

  // Notice container background alpha blend
  const noticeRgb = hexToRgb(noticeBgColor);
  noticeEl.style.background = `rgba(${noticeRgb.r}, ${noticeRgb.g}, ${noticeRgb.b}, ${noticeOpacity})`;

  // Auto Contrast logic based on background luminance and opacity for notice board
  const noticeLuminance = 0.299 * noticeRgb.r + 0.587 * noticeRgb.g + 0.114 * noticeRgb.b;
  const useDarkTextForNotice = (noticeOpacity > 0.3) && (noticeLuminance > 128);

  if (useDarkTextForNotice) {
    noticeEl.style.color = 'rgba(10, 15, 26, 0.95)';
    noticeTextEl.style.color = 'rgba(10, 15, 26, 0.95)';
    noticeEl.style.borderColor = 'rgba(0, 0, 0, 0.15)';
  } else {
    noticeEl.style.color = '';
    noticeTextEl.style.color = '';
    noticeEl.style.borderColor = 'rgba(255, 255, 255, 0.08)';
  }

  const noticeBlurStyle = noticeBlur && noticeOpacity > 0 ? `blur(${noticeOpacity * 16}px)` : 'none';
  noticeEl.style.backdropFilter = noticeBlurStyle;
  noticeEl.style.webkitBackdropFilter = noticeBlurStyle;
  
  // 4. Manage Notices broadcast visibility — requires both notify.visible AND non-empty announcement
  const noticeLayerVisible = preferences?.notify?.visible !== undefined ? preferences.notify.visible : false;
  if (noticeLayerVisible && announcement && announcement.trim() !== "") {
    noticeTextEl.textContent = announcement;
    noticeEl.classList.add('visible');
  } else {
    noticeEl.classList.remove('visible');
  }
}

function hexToRgb(hex) {
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

function hexToRgba(hex, opacity) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
}

// 1s Local Date Precision Clock Engine
function updateLocalClockTime() {
  if (!clockTextEl) return;
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  let ampm = '';
  if (!clock24h) {
    ampm = hours >= 12 ? 'PM ' : 'AM ';
    hours = hours % 12;
    hours = hours ? hours : 12;
  }
  const hoursStr = String(hours).padStart(2, '0');
  clockTextEl.textContent = clockShowSeconds ? `${ampm}${hoursStr}:${minutes}:${seconds}` : `${ampm}${hoursStr}:${minutes}`;
}



// Utility: Calculate position from 3x3 grid zone name
function calculatePosition(zone, offsetX, offsetY, W, H, fontSize) {
  let x = W / 2, y = H / 2;
  
  if (zone.includes('left'))   x = offsetX + fontSize * 2;
  if (zone.includes('right'))  x = W - offsetX - fontSize * 2;
  if (zone.includes('top'))    y = offsetY + fontSize;
  if (zone.includes('bottom')) y = H - offsetY - fontSize;
  
  // center overrides
  if (zone === 'center-center' || zone === 'top-center' || zone === 'bottom-center') {
    x = W / 2;
  }
  if (zone === 'center-left' || zone === 'center-center' || zone === 'center-right') {
    y = H / 2;
  }
  
  return { x, y };
}

// Utility: Measure text width
function measureText(ctx, text, fontSize, fontFamily) {
  ctx.font = `700 ${fontSize}px '${fontFamily}', sans-serif`;
  return ctx.measureText(text).width;
}

// Utility: Draw rounded rectangle
function roundRect(ctx, x, y, w, h, r) {
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

// Utility: ArrayBuffer to Base64 (efficient chunk encoding)
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}


