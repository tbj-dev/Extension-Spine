// Spine Viewer Extension (MVP bootstrap)
// Loads settings UI and bootstraps PIXI + pixi-spine for rendering.

import { extension_settings, getContext, doExtrasFetch } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";
import { saveSettingsDebounced, getRequestHeaders } from "../../../../script.js";

const extensionName = "Extension-Spine";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings for MVP
const defaultSettings = {
  allowMultipleMotions: false,
  enabled: false,
  showFrames: false,
  renderMode: 'auto', // 'auto' | 'overlay' | 'vn'
  dragMode: false,
  characterModelMapping: {}, // { characterName: { skeletonUrl|jsonUrl, atlasUrl, texturesBaseUrl } }
  characterModelsSettings: {}, // per-character model settings: { scale, offsetX, offsetY, zIndex }
  knownModels: {}, // global cache: skeletonUrl -> atlasUrl
};

// Debug helpers (temporary instrumentation)
const GLOBAL_SPEED_SCALE = 0.8; // Apply a global slowdown factor to all animation speeds
const IDLE_DBG = '[Spine Idle]';
function idleDbg(...args){ try { console.log(IDLE_DBG, ...args); } catch {} }
const SPINE_DBG = true;
function spineDbg(...args){ try { if (SPINE_DBG) console.debug('[Spine]', ...args); } catch {} }
function getAnimationNames(spine){
  try { return spine?.state?.data?.skeletonData?.animations?.map(a => a.name) || []; } catch { return []; }
}
function filterValidMotions(spine, motions){
  const names = new Set(getAnimationNames(spine));
  const arr = Array.isArray(motions) ? motions.filter(Boolean) : [String(motions)].filter(Boolean);
  const valid = arr.filter(m => names.has(m));
  const invalid = arr.filter(m => !names.has(m));
  if (invalid.length) spineDbg('Dropped invalid motions', { invalid, available: Array.from(names) });
  return valid;
}
function durationsFor(spine, motions){
  try {
    const list = motions || [];
    return list.map(m => {
      try { const data = spine?.state?.data?.skeletonData?.animations?.find(a => a.name === m); return Math.max(0, data?.duration || 0); } catch { return 0; }
    });
  } catch { return []; }
}
function scheduleIdleLikePlayButton(spine, idleMotions){
  try {
    const idleValid = filterValidMotions(spine, idleMotions);
    if (!idleValid.length) return;
    // Clear tracks and set idles per track
    try { spine.state.clearTracks(); } catch {}
    idleValid.forEach((im, i) => { try { spine.state.setAnimation(i, im, true); } catch {} });

    function forceIdleSingleTrack() {
      try {
        spineDbg('Force single-track idle fallback');
        try { spine.state.clearTracks(); } catch {}
        try { spine.state.setEmptyAnimations && spine.state.setEmptyAnimations(0); } catch {}
        try { spine.skeleton && spine.skeleton.setToSetupPose && spine.skeleton.setToSetupPose(); } catch {}
        try { spine.state.setAnimation(0, idleValid[0], true); } catch {}
        try { spine.state.apply && spine.skeleton && spine.state.apply(spine.skeleton); } catch {}
        try { spine.skeleton && spine.skeleton.updateWorldTransform && spine.skeleton.updateWorldTransform(); } catch {}
        try { spine.update && spine.update(0); } catch {}
      } catch {}
    }

    // Robust verification after a short delay
    setTimeout(() => {
      try {
        const entry = getCurrentEntry(spine);
        const okName = entry?.animation?.name && idleValid.includes(entry.animation.name);
        const okLoop = entry?.loop === true;
        if (!okName || !okLoop) {
          spineDbg('Idle not confirmed on track 0; applying fallback', { okName, okLoop, curName: entry?.animation?.name });
          forceIdleSingleTrack();
        }
      } catch { forceIdleSingleTrack(); }
    }, 60);

    // Second check in case mixing interfered
    setTimeout(() => {
      try {
        const entry = getCurrentEntry(spine);
        const okName = entry?.animation?.name && idleValid.includes(entry.animation.name);
        const okLoop = entry?.loop === true;
        if (!okName || !okLoop) {
          spineDbg('Idle still not confirmed; reapplying fallback');
          forceIdleSingleTrack();
        }
      } catch { forceIdleSingleTrack(); }
    }, 180);
  } catch {}
}

// Internal state
const apps = new Map(); // characterName -> PIXI.Application
const spineInstances = new Map(); // characterName -> spine instance
const currentModelKeyByChar = new Map(); // characterName -> currently attached model key (skeletonUrl/jsonUrl)
const pendingIdleByChar = new Map(); // characterName -> idleAnimation name
const pendingIdleTimerByChar = new Map(); // characterName -> timeout handle

function cancelIdleTimer(name){ try { const h = pendingIdleTimerByChar.get(name); if (h) clearTimeout(h); pendingIdleTimerByChar.delete(name); } catch {} }
function scheduleIdleTimer(name, delayMs, spine, idle){
  try {
    cancelIdleTimer(name);
    const h = setTimeout(() => {
      try { spine.state.setAnimation(0, idle, true); } catch {}
      clearPendingIdle(name);
      cancelIdleTimer(name);
    }, Math.max(0, delayMs|0));
    pendingIdleTimerByChar.set(name, h);
  } catch {}
}

function clearPendingIdle(name){ try { pendingIdleByChar.delete(name); pendingIdleCountdownByChar.delete(name); cancelIdleTimer(name); } catch {} }
function markIdleAfter(name, idleName){ if (idleName) pendingIdleByChar.set(name, String(idleName)); }
const pendingIdleCountdownByChar = new Map(); // characterName -> remaining engine-time seconds
function markIdleAfterCountdown(name, seconds){
  try {
    if (isFinite(seconds) && seconds > 0) pendingIdleCountdownByChar.set(name, Number(seconds) + 1e-4);
  } catch {}
}
function setIdleNow(name, spine, idle){
  try { spine.state.setAnimation(0, idle, true); } catch {}
  clearPendingIdle(name);
}
function checkAndApplyPendingIdleCountdown(name, spine, dtEngine){
  try {
    const want = pendingIdleByChar.get(name);
    if (!want) return;
    let remain = pendingIdleCountdownByChar.get(name);
    if (typeof remain !== 'number') return;
    const d = Math.max(0, Number(dtEngine) || 0);
    remain -= d;
    if (remain <= 0) {
      setIdleNow(name, spine, want);
    } else {
      pendingIdleCountdownByChar.set(name, remain);
    }
  } catch {}
}

function getCurrentEntry(spine){
  try {
    if (spine?.state?.getCurrent) return spine.state.getCurrent(0);
    if (spine?.state?.tracks) return spine.state.tracks[0] || null;
  } catch {}
  return null;
}
function isEntryComplete(entry){
  try {
    if (!entry) return true;
    if (typeof entry.isComplete === 'function') return entry.isComplete();
    const loop = !!entry.loop;
    if (loop) return false;
    const tt = Number(entry.trackTime ?? entry.time ?? 0);
    const end = Number(entry.trackEnd ?? entry.animationEnd ?? (entry.animation?.duration ?? 0));
    return tt >= (end - 1e-4);
  } catch { return false; }
}
function checkAndApplyPendingIdle(characterName, spine){
  try {
    const want = pendingIdleByChar.get(characterName);
    if (!want) return;
    const cur = getCurrentEntry(spine);
    const complete = (!cur || isEntryComplete(cur));
    idleDbg('ticker check', { characterName, want, hasCur: !!cur, complete, curName: cur?.animation?.name, trackTime: cur?.trackTime, trackEnd: cur?.trackEnd, animDur: cur?.animation?.duration });
    if (complete) {
      idleDbg('ticker set idle', { want });
      try { spine.state.setAnimation(0, want, true); } catch (e) { idleDbg('ticker set idle error', e?.message); }
      clearPendingIdle(characterName);
    }
  } catch (e) { idleDbg('ticker check error', e?.message); }
}

function getActiveCharacters() {
  try {
    const ctx = getContext();
    return (ctx?.characters || []).map(c => c.name);
  } catch {
    return [];
  }
}

// Only characters in the current chat (single: selected character, group: group members)
function getCurrentChatMembers() {
  try {
    const ctx = getContext();
    const groupId = ctx?.groupId;
    if (groupId !== null && groupId !== undefined) {
      // Build list from group members
      const out = [];
      for (const g of (ctx?.groups || [])) {
        if (String(g?.id) === String(groupId)) {
          for (const mem of (g?.members || [])) {
            let name = String(mem || '').replace(/\.[^/.]+$/, '');
            if (name.startsWith('default_')) name = name.substring('default_'.length);
            out.push(name);
          }
          break;
        }
      }
      out.sort();
      return out;
    }
    // Single chat fallback: just the active character
    const single = ctx?.name2;
    return single ? [String(single)] : [];
  } catch {
    return [];
  }
}

function getSpineForCharacter(name) {
  return spineInstances.get(name);
}

// Attempt to play starter shortly after a character is selected/attached
function schedulePlayStarterOnce(characterName, delayMs = 600, timeoutMs = 4000) {
  try {
    const start = performance.now ? performance.now() : Date.now();
    let tried = false;
    const tick = () => {
      try {
        const spine = getSpineForCharacter(characterName);
        if (spine && !tried) {
          tried = true;
          if (!playStarterForCharacter(characterName, spine)) {
            // No starter configured; do nothing
          }
          return; // stop after first attempt
        }
      } catch {}
      const now = performance.now ? performance.now() : Date.now();
      if (now - start < timeoutMs) {
        setTimeout(tick, 200);
      }
    };
    setTimeout(tick, Math.max(0, delayMs|0));
  } catch {}
}

// Helpers for idle handling (support Idle block with multiple motions and legacy single idleAnimation)
function getModelCfgForCharacter(name) {
  try {
    const s = extension_settings[extensionName] || {};
    const key = resolveModelKey(s, name);
    if (!key) return {};
    return (s.characterModelsSettings && s.characterModelsSettings[name] && s.characterModelsSettings[name][key]) || {};
  } catch {
    return {};
  }
}

function getIdleMotionsForCharacter(name) {
  try {
    const s = extension_settings[extensionName] || {};
    const cfg = getModelCfgForCharacter(name) || {};
    const multi = !!s.allowMultipleMotions;
    let arr = [];
    if (Array.isArray(cfg.idleMotions)) arr = cfg.idleMotions.filter(Boolean);
    else if (cfg.idleMotions) arr = [String(cfg.idleMotions)].filter(Boolean);
    if (arr.length === 0 && cfg.idleAnimation) arr = [String(cfg.idleAnimation)].filter(Boolean);
    if (!multi && arr.length > 1) arr = [arr[0]];
    return arr;
  } catch { return []; }
}

function playIdleForCharacter(name, spineOverride) {
  try {
    const spine = spineOverride || getSpineForCharacter(name);
    if (!spine) return false;
    const motions = getIdleMotionsForCharacter(name);
    if (!motions || motions.length === 0) return false;
    try { spine.state.clearTracks && spine.state.clearTracks(); } catch {}
    motions.forEach((m, i) => { try { spine.state.setAnimation(i, m, true); } catch {} });
    clearPendingIdle(name);
    return true;
  } catch { return false; }
}

function getStarterMotionsForCharacter(name) {
  try {
    const s = extension_settings[extensionName] || {};
    const cfg = getModelCfgForCharacter(name) || {};
    const multi = !!s.allowMultipleMotions;
    let arr = [];
    if (Array.isArray(cfg.starterMotions)) arr = cfg.starterMotions.filter(Boolean);
    else if (cfg.starterMotions) arr = [String(cfg.starterMotions)].filter(Boolean);
    if (arr.length === 0 && cfg.starterAnimation) arr = [String(cfg.starterAnimation)].filter(Boolean);
    if (!multi && arr.length > 1) arr = [arr[0]];
    return arr;
  } catch { return []; }
}

function playStarterForCharacter(name, spineOverride) {
  try {
    const spine = spineOverride || getSpineForCharacter(name);
    if (!spine) { console.debug('[Spine Starter]', name, 'no spine'); return false; }
    const motions = getStarterMotionsForCharacter(name);
    console.debug('[Spine Starter]', name, 'motions:', motions);
    if (!motions || motions.length === 0) return false;
    clearPendingIdle(name);
    motions.forEach((m, i) => { try { spine.state.setAnimation(i, m, false); } catch (e) { console.warn('[Spine Starter] setAnimation error', e?.message); } });
    // After starter finishes, try return to idle
    const durations = motions.map(m => {
      try {
        const data = spine?.state?.data?.skeletonData?.animations?.find(a => a.name === m);
        return Math.max(0, data?.duration || 0);
      } catch { return 0; }
    });
    const maxDur = Math.max(0, ...durations);
    setTimeout(() => { try { if (!playIdleForCharacter(name, spine)) { /* no idle configured */ } } catch {} }, Math.ceil((maxDur + 0.1) * 1000));
    return true;
  } catch (e) { console.warn('[Spine Starter] error', e); return false; }
}

function getModelKeyForCharacter(s, name) {
  const m = s.characterModelMapping?.[name];
  return m?.skeletonUrl || m?.jsonUrl || null;
}

function resolveModelKey(s, name) {
  const pref = getModelKeyForCharacter(s, name);
  if (pref) return pref;
  const obj = s.characterModelsSettings?.[name];
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length > 0) return keys[0];
  }
  return null;
}

// Top-level helpers (available to attachModel)
function getSavedModelCfg(characterName) {
  try {
    const s = extension_settings[extensionName] || {};
    const key = resolveModelKey(s, characterName);
    return (key && s.characterModelsSettings && s.characterModelsSettings[characterName] && s.characterModelsSettings[characterName][key]) || {};
  } catch { return {}; }
}

function applySavedTransformImmediate(characterName, spine, wrapper) {
  try {
    const cfg = getSavedModelCfg(characterName) || {};
    const targetW = Math.max(wrapper.clientWidth || window.innerWidth || 800, 10);
    const targetH = Math.max(wrapper.clientHeight || window.innerHeight || 600, 10);
    // Use local bounds to compute base scale (same logic as sliders)
    spine.update(0);
    let lb = null;
    try { lb = spine.getLocalBounds(); } catch {}
    if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) {
      const wb = spine.getBounds();
      const sx = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
      const sy = Math.max(Math.abs(spine.scale?.y || 1), 1e-6);
      lb = { x: (wb.x - (spine.x || 0)) / sx, y: (wb.y - (spine.y || 0)) / sy, width: Math.max(wb.width / sx, 1), height: Math.max(wb.height / sy, 1) };
    }
    const localW = Math.max(lb.width, 1);
    const localH = Math.max(lb.height, 1);
    const baseScale = 0.6 * Math.min(targetW / localW, targetH / localH);
    const userScale = Number(cfg.scale || 1.0);
    const scale = baseScale * (isFinite(userScale) ? userScale : 1.0);
    spine.scale.set(scale);
    const px = (targetW / 2) + (targetW / 2) * (Number(cfg.x) || 0) / 100;
    const py = (targetH / 2) + (targetH / 2) * (Number(cfg.y) || 0) / 100;
    const localCenterX = lb.x + localW / 2;
    const localCenterY = lb.y + localH / 2;
    spine.position.set(
      px - localCenterX * scale,
      py - localCenterY * scale
    );
  } catch {}
}

function scheduleApplySavedTransform(characterName, spine, wrapper, app) {
  // Re-apply transform once bounds have stabilized to avoid initial bottom-center jump.
  // We consider bounds "stable" when width/height stop changing across a few frames, or after a timeout.
  const MAX_MS = 4000; // safety timeout
  const REQUIRED_STABLE_FRAMES = 2;

  function applyNow() {
    try { applySavedTransformImmediate(characterName, spine, wrapper); } catch {}
  }

  try {
    const start = performance.now ? performance.now() : Date.now();
    let lastW = -1, lastH = -1;
    let stableFrames = 0;

    const tickCheck = () => {
      try { spine.update(0); } catch {}
      let w = 0, h = 0;
      try {
        const b = spine.getBounds();
        w = Math.max(0, Number(b && b.width));
        h = Math.max(0, Number(b && b.height));
      } catch {}

      if (w > 2 && h > 2) {
        if (Math.abs(w - lastW) < 0.5 && Math.abs(h - lastH) < 0.5) {
          stableFrames++;
        } else {
          stableFrames = 0;
        }
        lastW = w; lastH = h;
        if (stableFrames >= REQUIRED_STABLE_FRAMES) {
          applyNow();
          return true; // done
        }
      }

      const now = performance.now ? performance.now() : Date.now();
      if (now - start >= MAX_MS) {
        applyNow();
        return true; // timeout, but apply anyway
      }
      return false; // continue
    };

    if (app && app.ticker) {
      const fn = () => { if (tickCheck()) { try { app.ticker.remove(fn); } catch {} } };
      app.ticker.add(fn);
      return;
    }
  } catch {}

  // Fallback: rAF loop if ticker not available
  (function rafLoop() {
    const done = (() => {
      try { spine.update(0); } catch {}
      // reuse the same logic as above
      let w = 0, h = 0;
      try { const b = spine.getBounds(); w = Math.max(0, Number(b && b.width)); h = Math.max(0, Number(b && b.height)); } catch {}
      rafLoop._last = rafLoop._last || { w: -1, h: -1, stable: 0, start: (performance.now ? performance.now() : Date.now()) };
      const st = rafLoop._last;
      if (w > 2 && h > 2) {
        if (Math.abs(w - st.w) < 0.5 && Math.abs(h - st.h) < 0.5) st.stable++; else st.stable = 0;
        st.w = w; st.h = h;
        if (st.stable >= 2) { applyNow(); return true; }
      }
      const now = performance.now ? performance.now() : Date.now();
      if (now - st.start >= 4000) { applyNow(); return true; }
      return false;
    })();
    if (!done) requestAnimationFrame(rafLoop);
  })();
}


// Utilities
function ensureSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
}

function byId(id) { return document.getElementById(id); }

async function loadSettings() {
  ensureSettings();
  // Update UI
  const s = extension_settings[extensionName];
  const enabledEl = byId("spine_enabled_checkbox");
  if (enabledEl) enabledEl.checked = !!s.enabled;
  /* render mode removed from UI; always auto */
  const dragEl = byId('spine_drag_checkbox');
  if (dragEl) dragEl.checked = !!s.dragMode;
  const multiEl = byId('spine_multi_toggle');
  if (multiEl) multiEl.checked = !!s.allowMultipleMotions;
}

async function onEnabledChange(e) {
  ensureSettings();
  extension_settings[extensionName].enabled = !!e.target.checked;
  saveSettingsDebounced();
  if (extension_settings[extensionName].enabled) {
    await attachAllInChat();
  } else {
    await detachAll();
  }
}

async function unloadAssetsForMap(map) {
  if (!map) return;
  const pages = await (async () => {
    try {
      const txt = await fetch(map.atlasUrl, { cache: 'no-store' }).then(r => r.text());
      const lines = txt.split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (i + 1 < lines.length && lines[i + 1].startsWith('size:')) {
          const base = new URL(map.atlasUrl, location.origin);
          out.push(new URL(line, base).toString());
        }
      }
      return out;
    } catch { return []; }
  })();

  const skeletonUrl = map?.skeletonUrl || map?.jsonUrl;

  // Prefer clean unload via PIXI.Assets
  try {
    if (PIXI.Assets?.unload) {
      if (skeletonUrl) await PIXI.Assets.unload(skeletonUrl).catch(() => {});
      await PIXI.Assets.unload(map.atlasUrl).catch(() => {});
      for (const p of pages) {
        await PIXI.Assets.unload(p).catch(() => {});
      }
    }
  } catch {}
}

async function detachCharacter(characterName) {
  // Destroy stage and view first; do not force texture/baseTexture destruction
  const app = apps.get(characterName);
  if (app) {
    try { app.destroy(true, { children: true }); } catch {}
    apps.delete(characterName);
  }
  spineInstances.delete(characterName);
  const w = document.querySelector(`.spine-canvas-wrapper[data-character="${characterName}"]`);
  if (w && w.parentElement) w.parentElement.removeChild(w);
}

async function detachAll() {
  try {
    document.getElementById('visual-novel-wrapper')?.classList.remove('spine-suppress');
    document.getElementById('expression-wrapper')?.classList.remove('spine-suppress');
    document.querySelectorAll('.expression-holder.spine-suppress').forEach(el => el.classList.remove('spine-suppress'));
  } catch {}

  for (const [ch, app] of apps.entries()) {
    try { app.destroy(true, { children: true }); } catch { /* ignore */ }
  }
  apps.clear();
  spineInstances.clear();
  // Remove canvases
  document.querySelectorAll(".spine-canvas-wrapper").forEach(el => el.remove());
}

// Load PIXI + pixi-spine libraries dynamically
async function loadLibsOnce() {
  if (window.PIXI && window.PIXI.spine) return; // already loaded

  async function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(script);
    });
  }

  // Try local first
  const localLibs = [
    `${extensionFolderPath}/lib/pixi.min.js`,
    `${extensionFolderPath}/lib/pixi-spine.min.js`,
  ];

  try {
    for (const url of localLibs) {
      await loadScript(url);
    }
  } catch (e) {
    console.warn('[Spine] Local libs failed to load, falling back to CDN...', e);
    // Fallback to CDN versions (ensure compatibility of versions with your Spine data)
    const cdnCandidates = [
      ['https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
       'https://cdn.jsdelivr.net/npm/pixi-spine@3.1.11/dist/pixi-spine.umd.min.js'],
      ['https://unpkg.com/pixi.js@6.5.10/dist/browser/pixi.min.js',
       'https://unpkg.com/pixi-spine@3.1.11/dist/pixi-spine.umd.min.js'],
      ['https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
       'https://cdn.jsdelivr.net/npm/pixi-spine@3.1.11/dist/pixi-spine.js'],
    ];
    let loaded = false;
    for (const pair of cdnCandidates) {
      try {
        for (const url of pair) {
          await loadScript(url);
        }
        loaded = true;
        break;
      } catch (err) {
        console.warn('[Spine] CDN pair failed, trying next...', err);
      }
    }
    if (!loaded) throw new Error('Failed to load pixi/pixi-spine from CDN');
  }

  // Register pixi-spine loader plugins if available
  try {
    if (PIXI.spine && PIXI.spine.loaders && PIXI.Loader && PIXI.Loader.registerPlugin) {
      if (PIXI.spine.loaders.SpineLoader) PIXI.Loader.registerPlugin(PIXI.spine.loaders.SpineLoader);
      if (PIXI.spine.loaders.AtlasParser) PIXI.Loader.registerPlugin(PIXI.spine.loaders.AtlasParser);
    }
  } catch (err) {
    console.warn('[Spine] Could not register pixi-spine loader plugins', err);
  }
}

function findExpressionHolderForCharacter(name) {
  try {
    const ctx = getContext();
    const char = ctx.characters?.find(x => x.name === name);
    if (!char) return null;
    const holder = document.querySelector(`.expression-holder[data-avatar="${char.avatar}"]`);
    return holder || null;
  } catch {
    return null;
  }
}

function preferredContainerForCharacter(name) {
  const holder = findExpressionHolderForCharacter(name);
  if (holder) return holder;
  // Fallbacks
  return document.getElementById('visual-novel-wrapper')
      || document.getElementById('expression-wrapper')
      || document.body;
}

function createWrapper(characterName) {
  const container = preferredContainerForCharacter(characterName);
  const wrapper = document.createElement('div');
  wrapper.className = 'spine-canvas-wrapper';
  wrapper.dataset.character = characterName;
  // Fill parent; rely on parent's z-index ordering managed by ST
  wrapper.style.cssText = 'position:absolute; inset:0;';
  try {
    const allowPointer = !!(extension_settings[extensionName]?.dragMode);
    wrapper.style.pointerEvents = allowPointer ? 'auto' : 'none';
  } catch {}

  container.appendChild(wrapper);
  return wrapper;
}

async function attachModel(characterName) {
  ensureSettings();
  const s = extension_settings[extensionName];
  let map = s.characterModelMapping?.[characterName];
  let skeletonUrl = map?.skeletonUrl || map?.jsonUrl; // backward compat: jsonUrl may be .json or .skel

  // Fallback: if no explicit mapping, try resolve from saved model key and caches
  if (!map || !skeletonUrl || !map.atlasUrl) {
    try {
      const key = resolveModelKey(s, characterName);
      if (key) {
        skeletonUrl = key;
        // 1) Current character mapping
        let atlasUrl = '';
        const curMap = s.characterModelMapping?.[characterName];
        if (curMap && (curMap.skeletonUrl === skeletonUrl || curMap.jsonUrl === skeletonUrl)) atlasUrl = curMap.atlasUrl || '';
        // 2) Any character mapping
        if (!atlasUrl) {
          for (const [, m] of Object.entries(s.characterModelMapping || {})) {
            const k = String(m.skeletonUrl || m.jsonUrl || '');
            if (k === skeletonUrl && m.atlasUrl) { atlasUrl = m.atlasUrl; break; }
          }
        }
        // 3) Global knownModels cache
        if (!atlasUrl) atlasUrl = String((s.knownModels || {})[skeletonUrl] || '');
        // 4) Suffix inference in same folder (stem + .atlas)
        if (!atlasUrl) {
          try {
            const base = skeletonUrl.split('/').pop() || '';
            const folderOnly = skeletonUrl.replace(/[^/]+$/, '');
            const stem = base.replace(/\.(skel\.bytes|skel|json)$/i, '');
            const candidate = folderOnly + stem + '.atlas';
            const head = await fetch(candidate, { method: 'HEAD', cache: 'no-store' });
            if (head.ok) atlasUrl = candidate; else {
              const get = await fetch(candidate, { method: 'GET', cache: 'no-store' });
              if (get.ok) atlasUrl = candidate;
            }
          } catch {}
        }
        if (atlasUrl) {
          map = { jsonUrl: skeletonUrl, skeletonUrl, atlasUrl };
          // Persist mapping for future loads and update cache
          try {
            s.characterModelMapping = s.characterModelMapping || {};
            s.characterModelMapping[characterName] = map;
            s.knownModels = s.knownModels || {}; s.knownModels[skeletonUrl] = atlasUrl;
            saveSettingsDebounced();
          } catch {}
        }
      }
    } catch {}
  }

  if (!s.enabled || !map || !skeletonUrl || !map.atlasUrl) {
    console.debug('[Spine] attachModel skipped (missing config or disabled)', { characterName, enabled: s.enabled, map });
    return;
  }

  console.debug('[Spine] attachModel starting', {
    characterName,
    pixiVersion: (typeof PIXI !== 'undefined' && PIXI.VERSION) || 'unknown',
    hasAssets: !!(typeof PIXI !== 'undefined' && PIXI.Assets),
    hasLoader: !!(typeof PIXI !== 'undefined' && (PIXI.Loader || (PIXI.loaders && PIXI.loaders.Loader))),
    skeletonUrl,
    atlasUrl: map.atlasUrl,
  });

  await loadLibsOnce();

  // Clean up previous
  if (apps.has(characterName)) {
    try { apps.get(characterName).destroy(true, { children: true }); } catch {}
    apps.delete(characterName);
  }
  if (spineInstances.has(characterName)) {
    spineInstances.delete(characterName);
  }
  
  // Avoid manual tampering with PIXI.Assets cache here to prevent partial/stale state.
  // Proper unloading is handled by detachCharacter()/detachAll() via unloadAssetsForMap(map).

  const wrapper = createWrapper(characterName);
  // Suppress expression sprites when Spine is active (both VN and regular)
  try {
    const holder = document.querySelector(`.expression-holder[data-avatar="${getContext()?.characters?.find(c=>c.name===characterName)?.avatar}"]`);
    if (holder) holder.classList.add('spine-suppress');
    document.getElementById('visual-novel-wrapper')?.classList.add('spine-suppress');
    document.getElementById('expression-wrapper')?.classList.add('spine-suppress');
  } catch {}

  try {
    wrapper.style.zIndex = '2';
    const allowPointer = !!extension_settings[extensionName]?.dragMode;
    wrapper.style.pointerEvents = allowPointer ? 'auto' : 'none';
  } catch {}

  // Create PIXI application
  const app = new PIXI.Application({
    resizeTo: wrapper,
    backgroundAlpha: 0,
    antialias: true,
    powerPreference: 'high-performance',
  });
  wrapper.appendChild(app.view);
  try {
    const allowPointer = !!(extension_settings[extensionName]?.dragMode);
    if (app?.view) app.view.style.cursor = allowPointer ? 'grab' : 'default';
  } catch {}
  try { if (typeof updateSpinePointerEvents === 'function') updateSpinePointerEvents(); } catch {}

  // Ensure wrapper has a non-zero size; if not, make it fullscreen overlay as a fallback
  const ensureWrapperSized = () => {
    const rect = wrapper.getBoundingClientRect();
    const mode = extension_settings[extensionName]?.renderMode || 'auto';
    const overlay = (mode === 'overlay') || (mode === 'auto' && ((rect.width || 0) < 2 || (rect.height || 0) < 2));
    if (overlay) {
      wrapper.classList.add('spine-fullscreen');
      // Resize renderer to viewport explicitly
      const w = Math.max(window.innerWidth, 320);
      const h = Math.max(window.innerHeight, 240);
      try { app.renderer.resize(w, h); } catch {}
    } else {
      wrapper.classList.remove('spine-fullscreen');
    }
    // Update pointer-events: disable when fullscreen overlay to not block UI
    try {
      const allowPointer = !!extension_settings[extensionName]?.dragMode;
      const overlayActive = wrapper.classList.contains('spine-fullscreen');
      wrapper.style.pointerEvents = allowPointer ? 'auto' : 'none';
      try { const c = wrapper.querySelector('canvas'); if (c) c.style.cursor = allowPointer ? 'grab' : 'default'; } catch {}
    } catch {}
  };
  ensureWrapperSized();
  try {
    const rect0 = wrapper.getBoundingClientRect();
    if ((rect0.width || 0) < 2 || (rect0.height || 0) < 2) {
      console.debug('[Spine] Wrapper has zero size, reparenting to body as fullscreen overlay');
      try { wrapper.remove(); } catch {}
      try { document.body.appendChild(wrapper); } catch {}
      wrapper.classList.add('spine-fullscreen');
      // Set pointer events based on current drag mode so model can be dragged even in overlay
      try {
        const allowPointer = !!(extension_settings[extensionName]?.dragMode);
        wrapper.style.pointerEvents = allowPointer ? 'auto' : 'none';
        const c = wrapper.querySelector('canvas'); if (c) c.style.cursor = allowPointer ? 'grab' : 'default';
      } catch {}
      const w = Math.max(window.innerWidth, 320);
      const h = Math.max(window.innerHeight, 240);
      try { app.renderer.resize(w, h); } catch {}
      try { ensureWrapperSized(); } catch {}
    }
  } catch {}
  window.addEventListener('resize', ensureWrapperSized);

  // Load spine using pixi-spine loader; console.debug('attachModel using loader?', !!loader, 'PIXI.Assets?', !!PIXI.Assets);
  // Note: In v7, assets loader differs. For MVP, we use the Loader when available.
  const LoaderClass = PIXI.Loader || (PIXI.loaders && PIXI.loaders.Loader);
  const loader = (PIXI.Loader && PIXI.Loader.shared)
    || (PIXI.loaders && PIXI.loaders.shared)
    || (LoaderClass ? new LoaderClass() : null);
  const isSkel = /\.(skel|skel\.bytes)$/i.test(String(skeletonUrl || ''));
  if (!loader) {
    // Pixi v7 path using Assets
    if (PIXI.Assets) {
      console.debug('[Spine] Using Pixi v7 Assets pipeline');
      return (async () => {
        try {
          // Attempt to register pixi-spine loaders with Assets if available (once)
          try {
            const hasParsersAdd = PIXI.Assets && PIXI.Assets.loader && PIXI.Assets.loader.parsers && typeof PIXI.Assets.loader.parsers.add === 'function';
            window.__spineParsersRegistered = window.__spineParsersRegistered || false;
            if (!window.__spineParsersRegistered && PIXI.spine && PIXI.spine.loaders && hasParsersAdd) {
              try {
                PIXI.Assets.loader.parsers.add(new PIXI.spine.loaders.SpineLoader());
                console.debug('[Spine] SpineLoader registered');
              } catch (e1) {
                console.debug('[Spine] SpineLoader register error (likely already registered):', e1 && e1.message);
              }
              try {
                PIXI.Assets.loader.parsers.add(new PIXI.spine.loaders.AtlasParser());
                console.debug('[Spine] AtlasParser registered');
              } catch (e2) {
                console.debug('[Spine] AtlasParser register error (likely already registered):', e2 && e2.message);
              }
              window.__spineParsersRegistered = true;
            }
          } catch (err) {
            console.warn('[Spine v7] Failed to register Spine loaders', err);
          }

          // set preferences to resolve model black edge issue
          PIXI.Assets.setPreferences({
              preferCreateImageBitmap: false,
              preferWorker: false
          });

                    // Load atlas first to ensure textures are registered and not double-added across runs
          const atlasAlias = `spine_atlas_${characterName}_${Date.now()}`;
          console.debug('[Spine] Assets.add atlas', map.atlasUrl);
          await PIXI.Assets.add({ alias: atlasAlias, src: map.atlasUrl });
          console.debug('[Spine] Assets.load atlas alias');
          await PIXI.Assets.load(atlasAlias);
          console.debug('[Spine] Atlas loaded');

          const jsonAlias = `spine_skeleton_${characterName}_${Date.now()}`;
          console.debug('[Spine] Assets.add skeleton', skeletonUrl);
          // For .skel we need binary loader; pixi-spine Assets loader should detect by extension
          await PIXI.Assets.add({ alias: jsonAlias, src: skeletonUrl });
          console.debug('[Spine] Assets.load skeleton alias');
          const data = await PIXI.Assets.load(jsonAlias);
          console.debug('[Spine] Skeleton loaded', !!data);
          let spine;
          if (data instanceof PIXI.spine.Spine) {
            spine = data;
          } else if (data && (data.spineData || data.skeleton)) {
            const spineData = data.spineData || data.skeleton;
            spine = new PIXI.spine.Spine(spineData);
          } else {
            throw new Error('Assets.load returned no spineData');
          }
          console.debug('[Spine v7] Loaded spine:', { animations: spine.state?.data?.skeletonData?.animations?.map(a => a.name) });

          app.stage.addChild(spine);

          // Force an initial transform update and a render so bounds/localBounds are accurate
          try { app.stage.updateTransform(); } catch {}
          try { app.renderer && app.renderer.render && app.renderer.render(app.stage); } catch {}

          // Apply saved transform immediately using saved settings (no default bottom-center)
          try { applySavedTransformImmediate(characterName, spine, wrapper); } catch {}
          // Also schedule a re-apply after a couple frames to stabilize once bounds/renderer settle
          try { scheduleApplySavedTransform(characterName, spine, wrapper, app); } catch {}

          // Play starter if configured, otherwise idle fallback
          try {
            const playedStarter = playStarterForCharacter(characterName, spine);
            if (!playedStarter) {
              const ok = playIdleForCharacter(characterName, spine);
              if (!ok) {
                const fallback = spine.state?.data?.skeletonData?.animations?.[0]?.name || 'idle';
                spine.state.setAnimation(0, fallback, true);
              }
            }
          } catch (e) { console.warn('[Spine] setAnimation failed', e); }
          try { spine.update(0); } catch {}
          try {
            app.ticker.start();
            app.ticker.add((dt) => {
              const safeDt = ((dt || 1) / 60);
              try {
                const s = extension_settings[extensionName] || {};
                const key = resolveModelKey(s, characterName);
                const cfg = (key && s.characterModelsSettings && s.characterModelsSettings[characterName] && s.characterModelsSettings[characterName][key]) || {};
                const speed = Math.max(0.1, Number((cfg.animSpeed ?? 1.0))) * GLOBAL_SPEED_SCALE;
                const engineDt = safeDt * speed;
                spine.update(engineDt);
                checkAndApplyPendingIdle(characterName, spine);
                checkAndApplyPendingIdleCountdown(characterName, spine, engineDt);
              } catch {
                spine.update(safeDt);
                try { checkAndApplyPendingIdle(characterName, spine); checkAndApplyPendingIdleCountdown(characterName, spine, safeDt); } catch {}
              }
            });
          } catch {}

          // Apply animation speed; transform already applied above
          try { applyAnimSpeedLive(); } catch {}

          // Make the whole stage interactive to allow dragging like Live2D
          try {
            app.stage.interactive = true;
            app.stage.buttonMode = true;
            spine.interactive = true;
            let dragging = false;
            let startX = 0, startY = 0;

            // Click: play configured click motions and after behavior
            spine.on('pointertap', () => {
              try {
                const s3 = extension_settings[extensionName] || {};
                const key3 = resolveModelKey(s3, characterName);
                const cfg3 = key3 ? (s3.characterModelsSettings?.[characterName]?.[key3] || {}) : {};
                const clickConf = cfg3.clickConfig || { motion: [], behavior: 'idle' };
                const motions = Array.isArray(clickConf.motion) ? clickConf.motion.filter(Boolean) : [];
                const behavior = String(clickConf.behavior || 'none');
                if (motions.length === 0) return;
                if (behavior === 'loop') {
                  const motionsValid = filterValidMotions(spine, motions);
                  if (!motionsValid.length) { spineDbg('Click: no valid motions for loop'); return; }
                  motionsValid.forEach((m, i) => { try { spine.state.setAnimation(i, m, true); } catch {} });
                } else if (behavior === 'idle') {
                  const motionsValid = filterValidMotions(spine, motions);
                  const idleMotionsValid = filterValidMotions(spine, getIdleMotionsForCharacter(characterName));
                  // Queue idle immediately for seamless transition
                  motionsValid.forEach((m, i) => {
                    try { spine.state.setAnimation(i, m, false); } catch {}
                    try {
                      if (idleMotionsValid && idleMotionsValid.length && spine.state.addAnimation) {
                        const idleName = idleMotionsValid[i % idleMotionsValid.length];
                        spine.state.addAnimation(i, idleName, true, 0);
                      }
                    } catch {}
                  });
                  const durations = durationsFor(spine, motionsValid);
                  const maxDur = Math.max(0, ...durations);
                  setTimeout(() => { try { scheduleIdleLikePlayButton(spine, idleMotionsValid); } catch {} }, Math.ceil(maxDur * 1000));
                } else {
                  const motionsValid = filterValidMotions(spine, motions);
                  if (!motionsValid.length) { spineDbg('Click: no valid motions for play-once'); return; }
                  motionsValid.forEach((m, i) => { try { spine.state.setAnimation(i, m, false); } catch {} });
                }
              } catch {}
            });
            spine.cursor = 'grab';
            spine.on('pointerdown', (e) => {
              if (!extension_settings[extensionName]?.dragMode) return;
              dragging = true;
              spine.cursor = 'grabbing';
              startX = e.data.global.x - spine.x;
              startY = e.data.global.y - spine.y;
            });
            spine.on('pointerup', () => { dragging = false; spine.cursor = 'grab'; saveOffsets(true); });
            spine.on('pointerupoutside', () => { dragging = false; spine.cursor = 'grab'; saveOffsets(true); });
            spine.on('pointermove', (e) => {
              if (!dragging || !extension_settings[extensionName]?.dragMode) return;
              const nx = e.data.global.x - startX;
              const ny = e.data.global.y - startY;
              spine.position.set(nx, ny);
              saveOffsets(false);
            });

            function saveOffsets(commit) {
              ensureSettings();
              const s2 = extension_settings[extensionName];
              const name = characterName;
              const key = resolveModelKey(s2, name);
              if (!key) return;
              s2.characterModelsSettings[name] = s2.characterModelsSettings[name] || {};
              const cfg = s2.characterModelsSettings[name][key] = s2.characterModelsSettings[name][key] || {};

              // Convert absolute position -> percent center offsets to persist in new scheme
              try {
                const targetW = Math.max(wrapper.clientWidth || innerWidth || 800, 10);
                const targetH = Math.max(wrapper.clientHeight || innerHeight || 600, 10);
                const px = spine.x; const py = spine.y;
                // Recover local bounds for center
                spine.update(0);
                let lb = null; try { lb = spine.getLocalBounds(); } catch {}
                if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) {
                  const wb = spine.getBounds();
                  const sx = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
                  const sy = Math.max(Math.abs(spine.scale?.y || 1), 1e-6);
                  lb = { x: (wb.x - (spine.x || 0)) / sx, y: (wb.y - (spine.y || 0)) / sy, width: Math.max(wb.width / sx, 1), height: Math.max(wb.height / sy, 1) };
                }
                const localW = Math.max(lb.width, 1);
                const localH = Math.max(lb.height, 1);
                const localCenterX = lb.x + localW / 2;
                const localCenterY = lb.y + localH / 2;
                const scale = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
                const curCx = px + localCenterX * scale;
                const curCy = py + localCenterY * scale;
                const centerOffsetX = ((curCx - (targetW / 2)) / (targetW / 2)) * 100;
                const centerOffsetY = ((curCy - (targetH / 2)) / (targetH / 2)) * 100;
                cfg.x = Math.max(-100, Math.min(100, Math.round(centerOffsetX)));
                cfg.y = Math.max(-100, Math.min(100, Math.round(centerOffsetY)));

                // Reflect live values in the settings UI if this character is selected
                try {
                  const curSel = String($('#spine_character_select').val() || '');
                  if (curSel === name) {
                    $('#spine_model_x').val(cfg.x);
                    $('#spine_model_x_value').text(cfg.x);
                    $('#spine_model_y').val(cfg.y);
                    $('#spine_model_y_value').text(cfg.y);
                  }
                } catch {}
              } catch {}

              if (commit) saveSettingsDebounced();
            }
          } catch {}

          apps.set(characterName, app);
          spineInstances.set(characterName, spine);
        } catch (e) {
          console.error('[Spine v7] Failed to initialize model via Assets:', e);
          try { await unloadAssetsForMap(map); } catch {}
          try { app.destroy(true, { children: true }); } catch {}
          try { wrapper.remove(); } catch {}
        }
      })();
      return;
    } else {
      console.error('[Spine] No PIXI.Loader or PIXI.Assets available. Ensure Pixi v6 or v7 is loaded.');
      return;
    }
  }

  const atlasKey = `${characterName}_atlas`;
  const skelKey = `${characterName}_skeleton`;
  // Avoid duplicate adds on shared loader
  try { loader.resources && loader.resources[atlasKey] && loader.remove && loader.remove(atlasKey); } catch {}
  try { loader.resources && loader.resources[skelKey] && loader.remove && loader.remove(skelKey); } catch {}

  // Load atlas first so Spine loader can resolve attachments
  loader.add(atlasKey, map.atlasUrl);
  if (isSkel && loader && loader.add) {
    // Pixi v6: specify binary
    loader.add({ name: skelKey, url: skeletonUrl, xhrType: PIXI.LoaderResource ? PIXI.LoaderResource.XHR_RESPONSE_TYPE.BUFFER : 'arraybuffer' });
  } else {
    loader.add(skelKey, skeletonUrl);
  }

  loader.load((l, resources) => {
    try {
      // The pixi-spine v2 API typically expects a Spine multi-texture atlas. We need to build a Spine texture atlas.
      // For MVP simplicity, try auto-detect via pixi-spine if supported; otherwise, fail gracefully.
      const rawSkel = resources[skelKey]?.spineData || resources[skelKey]?.data;
      if (!rawSkel) throw new Error('Failed to load skeleton JSON');

      let spine;
      if (resources[skelKey].spineData) {
        spine = new PIXI.spine.Spine(resources[skelKey].spineData);
      } else if (typeof rawSkel === 'object') {
        spine = new PIXI.spine.Spine(rawSkel);
      } else {
        throw new Error('Loaded skeleton but no spineData available');
      }

      // Add to stage before computing bounds-based transform
      app.stage.addChild(spine);
      // Force an initial transform update and a render so bounds/localBounds are accurate
      try { app.stage.updateTransform(); } catch {}
      try { app.renderer && app.renderer.render && app.renderer.render(app.stage); } catch {}
      // Apply saved transform immediately using saved settings (no default bottom-center)
      try { applySavedTransformImmediate(characterName, spine, wrapper); } catch {}
      // Also schedule a re-apply after a couple frames to stabilize once bounds/renderer settle
      try { scheduleApplySavedTransform(characterName, spine, wrapper, app); } catch {}

      // Play starter if configured, otherwise idle fallback
      try {
        const playedStarter = playStarterForCharacter(characterName, spine);
        if (!playedStarter) {
          const ok = playIdleForCharacter(characterName, spine);
          if (!ok) {
            const fallback = spine.state?.data?.skeletonData?.animations?.[0]?.name || 'idle';
            spine.state.setAnimation(0, fallback, true);
          }
        }
      } catch {}

      // Apply persisted model settings and animation speed (deferred until bounds available)
      try { scheduleApplySavedTransform(characterName, spine, wrapper, app); applyAnimSpeedLive(); } catch {}

      // Enable dragging in Pixi v6 path as well
      try {
        app.stage.interactive = true;
        app.stage.buttonMode = true;
        spine.interactive = true;
        let dragging = false;
        let startX = 0, startY = 0;
        spine.cursor = 'grab';
        spine.on('pointerdown', (e) => {
          if (!extension_settings[extensionName]?.dragMode) return;
          dragging = true;
          spine.cursor = 'grabbing';
          startX = e.data.global.x - spine.x;
          startY = e.data.global.y - spine.y;
        });
        spine.on('pointerup', () => { dragging = false; spine.cursor = 'grab'; saveOffsets(true); });
        spine.on('pointerupoutside', () => { dragging = false; spine.cursor = 'grab'; saveOffsets(true); });
        spine.on('pointermove', (e) => {
          if (!dragging || !extension_settings[extensionName]?.dragMode) return;
          const nx = e.data.global.x - startX;
          const ny = e.data.global.y - startY;
          spine.position.set(nx, ny);
          saveOffsets(false);
        });
        function saveOffsets(commit) {
          ensureSettings();
          const s2 = extension_settings[extensionName];
          const name = characterName;
          const key = resolveModelKey(s2, name);
          if (!key) return;
          s2.characterModelsSettings[name] = s2.characterModelsSettings[name] || {};
          const cfg = s2.characterModelsSettings[name][key] = s2.characterModelsSettings[name][key] || {};
          try {
            const targetW = Math.max(wrapper.clientWidth || innerWidth || 800, 10);
            const targetH = Math.max(wrapper.clientHeight || innerHeight || 600, 10);
            const px = spine.x; const py = spine.y;
            spine.update(0);
            let lb = null; try { lb = spine.getLocalBounds(); } catch {}
            if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) {
              const wb = spine.getBounds();
              const sx = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
              const sy = Math.max(Math.abs(spine.scale?.y || 1), 1e-6);
              lb = { x: (wb.x - (spine.x || 0)) / sx, y: (wb.y - (spine.y || 0)) / sy, width: Math.max(wb.width / sx, 1), height: Math.max(wb.height / sy, 1) };
            }
            const localW = Math.max(lb.width, 1);
            const localH = Math.max(lb.height, 1);
            const localCenterX = lb.x + localW / 2;
            const localCenterY = lb.y + localH / 2;
            const scale = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
            const curCx = px + localCenterX * scale;
            const curCy = py + localCenterY * scale;
            const centerOffsetX = ((curCx - (targetW / 2)) / (targetW / 2)) * 100;
            const centerOffsetY = ((curCy - (targetH / 2)) / (targetH / 2)) * 100;
            cfg.x = Math.max(-100, Math.min(100, Math.round(centerOffsetX)));
            cfg.y = Math.max(-100, Math.min(100, Math.round(centerOffsetY)));
            // Update settings UI live
            try {
              const curSel = String($('#spine_character_select').val() || '');
              if (curSel === name) {
                $('#spine_model_x').val(cfg.x);
                $('#spine_model_x_value').text(cfg.x);
                $('#spine_model_y').val(cfg.y);
                $('#spine_model_y_value').text(cfg.y);
              }
            } catch {}
          } catch {}
          if (commit) saveSettingsDebounced();
        }
      } catch {}

      // Optional: ensure ticker running (Pixi v6 should auto-start, but be explicit)
      try {
        app.ticker.start();
        app.ticker.add((dt) => {
          const safeDt = ((dt || 1) / 60);
          try {
            const s6 = extension_settings[extensionName] || {};
            const key6 = resolveModelKey(s6, characterName);
            const cfg6 = (key6 && s6.characterModelsSettings && s6.characterModelsSettings[characterName] && s6.characterModelsSettings[characterName][key6]) || {};
            const speed6 = Math.max(0.1, Number((cfg6.animSpeed ?? 1.0))) * GLOBAL_SPEED_SCALE;
            const engineDt6 = safeDt * speed6;
            spine.update(engineDt6);
            checkAndApplyPendingIdle(characterName, spine);
            checkAndApplyPendingIdleCountdown(characterName, spine, engineDt6);
          } catch {
            spine.update(safeDt);
            try { checkAndApplyPendingIdle(characterName, spine); checkAndApplyPendingIdleCountdown(characterName, spine, safeDt); } catch {}
          }
        });
      } catch {}

      apps.set(characterName, app);
      spineInstances.set(characterName, spine);

      // Refresh UI selects to reflect saved motions
      setTimeout(() => { try { renderIdleStarterBlocks(); updateModelSettingsUi(); } catch {} }, 200);
    } catch (e) {
      console.error('[Spine] Failed to initialize model:', e);
      try { app.destroy(true, { children: true, texture: true, baseTexture: true }); } catch {}
      wrapper.remove();
    }
  });
}

async function attachAllInChat() {
  // Attach selected character in single chat, or all members in group chat, using either explicit mapping or saved model key
  ensureSettings();
  const s = extension_settings[extensionName];
  const map = s.characterModelMapping || {};
  const members = getCurrentChatMembers();

  console.debug('[Spine] attachAllInChat, members:', members);

  const targets = new Set();
  for (const name of members) {
    if (map[name] || resolveModelKey(s, name)) targets.add(name);
  }

  console.debug('[Spine] attachAllInChat, targets:', targets);

  // Attach targets
  for (const name of targets) {
    console.debug('[Spine] attachAllInChat, attaching', name);
    if (!apps.has(name)) await attachModel(name);
  }
  // Detach any non-targets currently attached
  for (const [name] of apps.entries()) {
    console.debug('[Spine] attachAllInChat, detaching', name);
    if (!targets.has(name)) await detachCharacter(name);
  }
  try { if (typeof updateSpinePointerEvents === 'function') updateSpinePointerEvents(); } catch {}
}

function getWrapperForCharacter(name) {
  return document.querySelector(`.spine-canvas-wrapper[data-character="${name}"]`);
}

function attachOrReparent(characterName) {
  const desired = preferredContainerForCharacter(characterName);
  let wrapper = getWrapperForCharacter(characterName);
  if (!wrapper || !wrapper.isConnected) {
    console.debug('[Spine] attachOrReparent Attaching model for', characterName);
    attachModel(characterName);
    return;
  }
  if (wrapper.parentElement !== desired) {
    desired.appendChild(wrapper);
  }
}

function refreshContainers() {
  if (!extension_settings[extensionName]?.enabled) return;
  // Only reparent currently attached characters to avoid spawning models for others
  for (const [characterName] of apps.entries()) {
    try { attachOrReparent(characterName); } catch {}
  }
}

async function onChatChanged() {
  if (!extension_settings[extensionName]?.enabled) return;
  // Re-attach all configured models (simple strategy)
  await detachAll();
  await attachAllInChat();
}

// Load settings UI
jQuery(async () => {
  // Inject settings panel
  try {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
  } catch (e) {
    console.warn('[Spine] Failed to load settings.html', e);
  }

  // Default assets base for Spine under ST data folder
  const DEFAULT_SPINE_HTTP_BASE = '/assets/spine/'; // default start path for adding models

  // Populate character list
  function populateCharacters() {
    const chars = getCurrentChatMembers();
    const sel = $('#spine_character_select');
    sel.empty();
    for (const name of chars) sel.append(`<option value="${name}">${name}</option>`);
    // If single chat, preselect the only item
    if (chars.length === 1) sel.val(chars[0]);
  }
  populateCharacters();
  // Try to render mapping table on load if a model is already attached
  setTimeout(() => { try { renderMappingTable(); updateModelSettingsUi(); refreshAnimationSelects(); refreshSavedModelsList(); } catch {} }, 500);

  // Auto-refresh animations when character selection changes
  $(document).on('change', '#spine_character_select', function(){
    try { updateModelSettingsUi(); refreshAnimationSelects(); renderMappingTable(); refreshSavedModelsList(); } catch {}
    try { const name = String($('#spine_character_select').val() || ''); if (name) schedulePlayStarterOnce(name, 400, 4000); } catch {}
  });

  // Bind UI events
  $(document).on('input', '#spine_enabled_checkbox', onEnabledChange);
  $(document).on('change', '#spine_render_mode', async function(){
    ensureSettings();
    extension_settings[extensionName].renderMode = String($(this).val() || 'auto');
    saveSettingsDebounced();
    // Re-attach to apply mode change
    await detachAll();
    await attachAllInChat();
  });
  window.spineUpdatePointerEvents = function() {
    try {
      const allowPointer = !!(extension_settings[extensionName]?.dragMode);
      document.querySelectorAll('.spine-canvas-wrapper').forEach(w => {
        w.style.pointerEvents = (allowPointer ? 'auto' : 'none');
        const canvas = w.querySelector('canvas');
        if (canvas) canvas.style.cursor = allowPointer ? 'grab' : 'default';
      });
    } catch {}
  }
  // Provide a legacy alias for older call sites
  window.updateSpinePointerEvents = window.spineUpdatePointerEvents;

  $(document).on('input', '#spine_drag_checkbox', function(){
    ensureSettings();
    extension_settings[extensionName].dragMode = !!$(this).prop('checked');
    saveSettingsDebounced();
    if (window.spineUpdatePointerEvents) window.spineUpdatePointerEvents();
  });
  $(document).on('input', '#spine_multi_toggle', function(){
    ensureSettings();
    extension_settings[extensionName].allowMultipleMotions = !!$(this).prop('checked');
    saveSettingsDebounced();
    try { renderIdleStarterBlocks(); } catch {}
    try { renderMappingTable(); } catch {}
  });
  $(document).on('click', '#spine_char_refresh', function(){ populateCharacters(); });

  async function querySpineAssetsLocal() { return []; }

  function populateModelSelect(list) { $('#spine_model_select').empty(); for (const item of list) { $('#spine_model_select').append(`<option value="${item.value}">${item.label}</option>`); } }

  function buildSavedModelsItemsForCharacter(charName) {
    const s = extension_settings[extensionName] || {};
    const items = [];
    if (!charName) return items;

    // Explicit mapping for this character
    const map = s.characterModelMapping?.[charName];
    if (map && (map.skeletonUrl || map.jsonUrl)) {
      const skel = String(map.skeletonUrl || map.jsonUrl);
      const folder = skel.replace(/[^/]+$/, '');
      items.push({ value: skel, label: `${folder}` });
    }

    // Per-character saved settings keys for this character only
    const models = s.characterModelsSettings?.[charName];
    if (models && typeof models === 'object') {
      for (const key of Object.keys(models)) {
        const skel = String(key || '');
        if (!skel) continue;
        const folder = skel.replace(/[^/]+$/, '');
        items.push({ value: skel, label: `${folder}` });
      }
    }

    // Deduplicate by value
    const uniq = [];
    const seen = new Set();
    for (const it of items) { const k = it.value; if (!seen.has(k)) { uniq.push(it); seen.add(k); } }
    return uniq;
  }

  function refreshSavedModelsList(selectValue) {
    try {
      const curChar = String($('#spine_character_select').val() || '');
      const list = buildSavedModelsItemsForCharacter(curChar);
      populateModelSelect(list);
      if (selectValue) { $('#spine_model_select').val(selectValue); }
    } catch {}
  }

  // On load, populate the Saved Models dropdown from saved settings
  (async () => {
    try {
      const s = extension_settings[extensionName] || {};
      // Prime global knownModels cache from any saved character mappings (cross-character discovery only for atlas lookup)
      try {
        s.knownModels = s.knownModels || {};
        for (const [, map] of Object.entries(s.characterModelMapping || {})) {
          const sk = String(map.skeletonUrl || map.jsonUrl || '');
          const at = String(map.atlasUrl || '');
          if (sk && at) s.knownModels[sk] = at;
        }
        saveSettingsDebounced();
      } catch {}

      // Populate the dropdown only with current character's models
      refreshSavedModelsList();
    } catch {}
  })();

  // Model save/apply: all guesses removed; rely solely on Browse suffix detection.

  $(document).on('click', '#spine_folder_browse', function(){
    // We cannot force the OS picker start path, but we can guide the user via a toast
    try { toastr.info('Select a model folder under ' + DEFAULT_SPINE_HTTP_BASE); } catch {}
    $('#spine_folder_picker').val('');
    $('#spine_folder_picker').trigger('click');
  });

  $(document).on('change', '#spine_folder_picker', async function(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // Scan all selected files to find a skeleton and an atlas by suffix
    const lower = (s) => String(s || '').toLowerCase();
    let skeletonRel = '';
    let atlasRel = '';

    for (const f of files) {
      const rpRaw0 = (f.webkitRelativePath || f.name || '').replace(/\\/g, '/');
      // If the picked path contains 'assets/spine', prefer the part after it to preserve any extra subfolders like 'ba/'
      const idx = rpRaw0.toLowerCase().lastIndexOf('/assets/spine/');
      const rpRaw = idx !== -1 ? rpRaw0.substring(idx + '/assets/spine/'.length) : rpRaw0;
      const rp = rpRaw.replace(/^\/+/, '').replace(/^\.\//, '');
      const l = lower(rp);
      if (!atlasRel && l.endsWith('.atlas')) atlasRel = rp;
      if (!skeletonRel && (l.endsWith('.skel') || l.endsWith('.skel.bytes') || l.endsWith('.json'))) skeletonRel = rp;
      if (atlasRel && skeletonRel) break;
    }

    // Normalize relative paths
    const normalizedSkeletonRel = skeletonRel ? skeletonRel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '') : '';
    const normalizedAtlasRel = atlasRel ? atlasRel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '') : '';

    // Determine the subdirectory under /assets/spine by taking the directory part of the skeleton/atlas
    const skeletonDir = normalizedSkeletonRel ? normalizedSkeletonRel.replace(/[^/]+$/, '') : '';
    const atlasDir = normalizedAtlasRel ? normalizedAtlasRel.replace(/[^/]+$/, '') : '';
    const dirCommon = (function(){
      if (skeletonDir && atlasDir) {
        if (skeletonDir === atlasDir) return skeletonDir;
        const a = skeletonDir.split('/').filter(Boolean);
        const b = atlasDir.split('/').filter(Boolean);
        const len = Math.min(a.length, b.length);
        const out = [];
        for (let i = 0; i < len; i++) { if (a[i] === b[i]) out.push(a[i]); else break; }
        return out.length ? out.join('/') + '/' : (skeletonDir || atlasDir);
      }
      return skeletonDir || atlasDir || '';
    })();

    // Build the HTTP folder and full URLs preserving nested subfolders (e.g., /assets/spine/ba/model/...)
    let computedBaseFolder = DEFAULT_SPINE_HTTP_BASE + dirCommon.replace(/^\/+/, '');
    if (!computedBaseFolder.startsWith('/')) computedBaseFolder = '/' + computedBaseFolder;
    if (!computedBaseFolder.endsWith('/')) computedBaseFolder += '/';

    // No folder input in UI anymore; we rely on computedBaseFolder and canonical assets base

    // Build HTTP urls off the canonical assets base. The relative part already includes any nested subfolders (e.g., "ba/")
    let httpSkel = DEFAULT_SPINE_HTTP_BASE + normalizedSkeletonRel;
    let httpAtlas = DEFAULT_SPINE_HTTP_BASE + normalizedAtlasRel;

    // Preflight check: ensure files are accessible under /assets/spine (covers all OS paths)
    try {
      let ok1 = await fetch(httpSkel, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
      let ok2 = await fetch(httpAtlas, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
      if (!ok1 || !ok2) {
        // Some servers may not support HEAD; try GET as fallback
        const gg1 = ok1 ? true : await fetch(httpSkel, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
        const gg2 = ok2 ? true : await fetch(httpAtlas, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
        ok1 = ok1 || gg1; ok2 = ok2 || gg2;
      }
      // If still not ok, try to infer missing intermediate subfolder (e.g., '/assets/spine/ba/...')
      if (!ok1 || !ok2) {
        try {
          const s = extension_settings[extensionName] || {};
          const prefixes = new Set();
          const pushPrefix = (p) => { try { const m = String(p||'').match(/\/assets\/spine\/([^/]+)\//i); if (m && m[1]) prefixes.add(m[1]); } catch {} };
          // from knownModels
          try { for (const [sk, at] of Object.entries(s.knownModels || {})) { pushPrefix(sk); pushPrefix(at); } } catch {}
          // from character mappings
          try { for (const [, m] of Object.entries(s.characterModelMapping || {})) { pushPrefix(m?.skeletonUrl || m?.jsonUrl || ''); pushPrefix(m?.atlasUrl || ''); } } catch {}
          // Try any prefixes we already know from previous models
          for (const prefix of prefixes) {
            const testSkel = `${DEFAULT_SPINE_HTTP_BASE}${prefix}/${normalizedSkeletonRel}`;
            const testAtlas = `${DEFAULT_SPINE_HTTP_BASE}${prefix}/${normalizedAtlasRel}`;
            const h1 = await fetch(testSkel, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
            const h2 = await fetch(testAtlas, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
            let g1 = h1, g2 = h2;
            if (!h1) g1 = await fetch(testSkel, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
            if (!h2) g2 = await fetch(testAtlas, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
            if (g1 && g2) {
              httpSkel = testSkel; httpAtlas = testAtlas;
              // No folder input UI; nothing to update here
              ok1 = ok2 = true;
              break;
            }
          }
          // Also try a small set of common subfolders (e.g., Blue Archive uses 'ba')
          if (!ok1 || !ok2) {
            const common = ['ba'];
            for (const prefix of common) {
              const testSkel = `${DEFAULT_SPINE_HTTP_BASE}${prefix}/${normalizedSkeletonRel}`;
              const testAtlas = `${DEFAULT_SPINE_HTTP_BASE}${prefix}/${normalizedAtlasRel}`;
              const h1 = await fetch(testSkel, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
              const h2 = await fetch(testAtlas, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
              let g1 = h1, g2 = h2;
              if (!h1) g1 = await fetch(testSkel, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
              if (!h2) g2 = await fetch(testAtlas, { method: 'GET', cache: 'no-store' }).then(r => r.ok).catch(() => false);
              if (g1 && g2) {
                httpSkel = testSkel; httpAtlas = testAtlas;
                let newBase = `${DEFAULT_SPINE_HTTP_BASE}${prefix}/${dirCommon.replace(/^\/+/, '')}`;
                if (!newBase.endsWith('/')) newBase += '/';
                try { $('#spine_model_folder').val(newBase); } catch {}
                ok1 = ok2 = true;
                break;
              }
            }
          }
        } catch {}
      }
      if (!ok1 || !ok2) {
        try { toastr.error('Spine: Please select a folder under data/default-user/assets/spine (files not accessible).'); } catch {}
        return;
      }
    } catch {
      try { toastr.error('Spine: Please select a folder under data/default-user/assets/spine.'); } catch {}
      return;
    }

    // If found and accessible, set full HTTP paths
    if (skeletonRel) $('#spine_model_json').val(httpSkel);
    if (atlasRel) $('#spine_model_atlas').val(httpAtlas);

    // If either file is missing, notify user
    if (!skeletonRel || !atlasRel) {
      try { toastr.error('Spine: Could not find both skeleton (.json/.skel/.skel.bytes) and .atlas in the selected folder.'); } catch {}
      return;
    }

    // Auto-apply immediately (mimic Save/Apply)
    try {
      const s = extension_settings[extensionName];
      const name = String($('#spine_character_select').val() || '');
      const skeletonUrl = String($('#spine_model_json').val() || '').trim();
      const atlasUrl = String($('#spine_model_atlas').val() || '').trim();
      if (!name || !skeletonUrl || !atlasUrl) return;
      s.characterModelMapping[name] = { jsonUrl: skeletonUrl, skeletonUrl, atlasUrl };
      // Update Saved Models list and global cache
      try { refreshSavedModelsList(skeletonUrl); } catch {}
      try { s.knownModels = s.knownModels || {}; s.knownModels[skeletonUrl] = atlasUrl; } catch {}
      saveSettingsDebounced();
      await unloadAssetsForMap({ skeletonUrl, atlasUrl });
      await detachCharacter(name);
      await attachModel(name);
      setTimeout(() => { try { refreshAnimationSelects(); renderMappingTable(); } catch {} }, 500);
      try { toastr.success('Spine model applied'); } catch {}
    } catch {}
  });

  $(document).on('click', '#spine_model_detect', async function(){
    // No more name guesses: require the user to Browse and select the folder so we can scan its files
    try { toastr.info('Please use Browse to select a folder; the extension will auto-detect .json/.skel(.bytes)/.atlas by suffix.'); } catch {}
  });
  $(document).on('change', '#spine_model_select', async function(){
    // Selecting a different model should reload settings/mapping for that model
    const selected = String($('#spine_model_select').val() || '').trim();
    if (!selected) return;

    // Interpret the Saved Models value: it may be a skeleton url or a folder
    let skeletonUrl = selected;
    if (/\/$/.test(skeletonUrl)) {
      // Value is a folder; try to find a matching skeletonUrl in saved settings
      const s = extension_settings[extensionName] || {};
      const all = Object.values(s.characterModelMapping || {});
      const hit = all.find(m => String(m.skeletonUrl || m.jsonUrl || '').replace(/[^/]+$/, '/') === skeletonUrl);
      if (hit) skeletonUrl = String(hit.skeletonUrl || hit.jsonUrl || skeletonUrl);
    }

    // No model folder UI anymore

    // If we have a mapping that includes atlas for this skeleton, apply immediately; else try global cache; else ask to Browse
    const s = extension_settings[extensionName] || {};
    let atlasUrl = '';
    // 1) Current character mapping
    const curChar = String($('#spine_character_select').val() || '');
    const curMap = s.characterModelMapping?.[curChar];
    if (curMap && (curMap.skeletonUrl === skeletonUrl || curMap.jsonUrl === skeletonUrl)) {
      atlasUrl = curMap.atlasUrl || '';
    }
    // 2) Any character mapping
    if (!atlasUrl) {
      for (const [, map] of Object.entries(s.characterModelMapping || {})) {
        const key = String(map.skeletonUrl || map.jsonUrl || '');
        if (key === skeletonUrl && map.atlasUrl) { atlasUrl = map.atlasUrl; break; }
      }
    }
    // 3) Global cache
    if (!atlasUrl) {
      atlasUrl = String((s.knownModels || {})[skeletonUrl] || '');
    }
    // 4) Try infer atlas from skeleton base name in same folder (suffix-only inference)
    if (!atlasUrl) {
      try {
        const baseName = skeletonUrl.split('/').pop() || '';
        const folderOnly = skeletonUrl.replace(/[^/]+$/, '');
        const stem = baseName.replace(/\.(skel\.bytes|skel|json)$/i, '');
        const candidate = folderOnly + stem + '.atlas';
        const head = await fetch(candidate, { method: 'HEAD', cache: 'no-store' });
        if (head.ok) atlasUrl = candidate;
        else {
          const get = await fetch(candidate, { method: 'GET', cache: 'no-store' });
          if (get.ok) atlasUrl = candidate;
        }
      } catch {}
    }
    if (atlasUrl) {
      // Inline apply selected model to current character
      const name = String($('#spine_character_select').val() || '');
      if (name) {
        try {
          const s2 = extension_settings[extensionName];
          s2.characterModelMapping = s2.characterModelMapping || {};
          s2.characterModelMapping[name] = { jsonUrl: skeletonUrl, skeletonUrl, atlasUrl };
          // Cache globally for future reuse
          try { s2.knownModels = s2.knownModels || {}; s2.knownModels[skeletonUrl] = atlasUrl; } catch {}
          saveSettingsDebounced();
          // Unload and re-attach
          await unloadAssetsForMap({ skeletonUrl, atlasUrl });
          await detachCharacter(name);
          await attachModel(name);
          setTimeout(() => { try { refreshAnimationSelects(); renderMappingTable(); updateModelSettingsUi(); } catch {} }, 300);
        } catch {}
      }
    } else {
      try { toastr.info('Atlas not recorded for this model. Click Browse for the folder to auto-detect files by suffix.'); } catch {}
    }
  });

  $(document).on('click', '#spine_model_detect_apply', async function(){
    ensureSettings();
    const s = extension_settings[extensionName];
    const name = String($('#spine_character_select').val() || '');
    const skeletonUrl = String($('#spine_model_json').val() || '').trim();
    const atlasUrl = String($('#spine_model_atlas').val() || '').trim();

    if (!name || !skeletonUrl || !atlasUrl) { toastr.error('Please Browse to select a folder so the extension can auto-detect .json/.skel(.bytes) and .atlas'); return; }
    // Backward-compatible storage (keep jsonUrl for previous code paths)
    s.characterModelMapping[name] = { jsonUrl: skeletonUrl, skeletonUrl, atlasUrl };
    // Update Saved Models list instantly
    try { refreshSavedModelsList(skeletonUrl); } catch {}
    // Update global known models cache for future reuse across characters
    try { s.knownModels = s.knownModels || {}; s.knownModels[skeletonUrl] = atlasUrl; } catch {}
    saveSettingsDebounced();
    // Thoroughly reset this character before reloading
    await unloadAssetsForMap({ skeletonUrl, atlasUrl });
    await detachCharacter(name);
    console.debug('[Spine] spine_model_detect_apply Attaching model for', name);
    await attachModel(name);
    setTimeout(() => { try { refreshAnimationSelects(); renderMappingTable(); } catch {} }, 800);
    toastr.success('Model applied');
  });

  // Remove model
  $(document).on('click', '#spine_model_remove', function(){
    ensureSettings();
    const s = extension_settings[extensionName];
    const name = String($('#spine_character_select').val() || '');
    if (!name) return;
    delete s.characterModelMapping[name];
    saveSettingsDebounced();
    detachAll();
    attachAllInChat();
  });

  // Model Settings handlers (non-invasive)
  function getModelCfg(name) {
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    if (!key) return null;
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    s.characterModelsSettings[name][key] = s.characterModelsSettings[name][key] || { scale: 1.0, x: 0, y: 0, animSpeed: 1.0, classifyMapping: {} };
    return s.characterModelsSettings[name][key];
  }

  function updateModelSettingsUi() {
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    if (!cfg) return;
    $('#spine_model_scale').val(cfg.scale ?? 1.0);
    $('#spine_model_scale_value').text(cfg.scale ?? 1.0);
    $('#spine_model_x').val(cfg.x ?? 0);
    $('#spine_model_x_value').text(cfg.x ?? 0);
    $('#spine_model_y').val(cfg.y ?? 0);
    $('#spine_model_y_value').text(cfg.y ?? 0);
    $('#spine_anim_speed').val(cfg.animSpeed ?? 0.8);
    $('#spine_anim_speed_value').text(cfg.animSpeed ?? 0.8);
  }

  function applyModelSettingsFor(name) {
    const cfg = getModelCfg(name);
    const spine = getSpineForCharacter(name);
    const wrapper = getWrapperForCharacter(name) || preferredContainerForCharacter(name);
    if (!cfg || !spine || !wrapper) return;
    try {
      const targetW = Math.max(wrapper.clientWidth || 800, 10);
      const targetH = Math.max(wrapper.clientHeight || 600, 10);
      spine.update(0);
      let lb = null;
      try { lb = spine.getLocalBounds(); } catch {}
      if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) {
        const wb = spine.getBounds();
        const sx = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
        const sy = Math.max(Math.abs(spine.scale?.y || 1), 1e-6);
        lb = { x: (wb.x - (spine.x || 0)) / sx, y: (wb.y - (spine.y || 0)) / sy, width: Math.max(wb.width / sx, 1), height: Math.max(wb.height / sy, 1) };
      }
      const localW = Math.max(lb.width, 1);
      const localH = Math.max(lb.height, 1);
      const baseScale = 0.6 * Math.min(targetW / localW, targetH / localH);
      const userScale = Number(cfg.scale || 1.0);
      const scale = baseScale * userScale;
      spine.scale.set(scale);
      const px = (targetW / 2) + (targetW / 2) * (Number(cfg.x) || 0) / 100;
      const py = (targetH / 2) + (targetH / 2) * (Number(cfg.y) || 0) / 100;
      const localCenterX = lb.x + localW / 2;
      const localCenterY = lb.y + localH / 2;
      spine.position.set(
        px - localCenterX * scale,
        py - localCenterY * scale
      );
    } catch {}
  }

  function applyModelSettingsLive() {
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    const spine = getSpineForCharacter(name);
    const wrapper = getWrapperForCharacter(name) || preferredContainerForCharacter(name);
    if (!cfg || !spine || !wrapper) return;
    try {
      const targetW = Math.max(wrapper.clientWidth || 800, 10);
      const targetH = Math.max(wrapper.clientHeight || 600, 10);
      // Use local bounds to avoid feedback from current transforms
      spine.update(0);
      let lb = null;
      try { lb = spine.getLocalBounds(); } catch {}
      // Fallback to world bounds de-normalized if needed
      if (!lb || !isFinite(lb.width) || lb.width <= 0 || !isFinite(lb.height) || lb.height <= 0) {
        const wb = spine.getBounds();
        const sx = Math.max(Math.abs(spine.scale?.x || 1), 1e-6);
        const sy = Math.max(Math.abs(spine.scale?.y || 1), 1e-6);
        lb = {
          x: (wb.x - (spine.x || 0)) / sx,
          y: (wb.y - (spine.y || 0)) / sy,
          width: Math.max(wb.width / sx, 1),
          height: Math.max(wb.height / sy, 1),
        };
      }
      const localW = Math.max(lb.width, 1);
      const localH = Math.max(lb.height, 1);
      const scaleX = targetW / localW;
      const scaleY = targetH / localH;
      const baseScale = 0.6 * Math.min(scaleX, scaleY);
      const userScale = Number(cfg.scale || 1.0);
      const scale = baseScale * userScale;
      spine.scale.set(scale);
      const px = (targetW / 2) + (targetW / 2) * (Number(cfg.x) || 0) / 100;
      const py = (targetH / 2) + (targetH / 2) * (Number(cfg.y) || 0) / 100;
      // Position so that the local center lands at target (px, py)
      const localCenterX = lb.x + localW / 2;
      const localCenterY = lb.y + localH / 2;
      spine.position.set(
        px - localCenterX * scale,
        py - localCenterY * scale
      );
    } catch {}
  }

  function scheduleApplyModelSettings(name, timeoutMs = 2500) {
    const app = apps.get(name);
    if (app && app.ticker) {
      let frames = 0;
      const fn = () => {
        frames++;
        if (frames >= 2) {
          try { applyModelSettingsFor(name); } catch {}
          try { app.ticker.remove(fn); } catch {}
        }
      };
      app.ticker.add(fn);
      return;
    }
    // Fallback to rAF-based stabilization if no ticker yet
    const start = performance.now ? performance.now() : Date.now();
    let lastW = 0, lastH = 0, stableFrames = 0;
    function attempt() {
      try {
        const spine = getSpineForCharacter(name);
        const wrapper = getWrapperForCharacter(name) || preferredContainerForCharacter(name);
        if (!spine || !wrapper) { requestAnimationFrame(attempt); return; }
        try { spine.update(0); } catch {}
        const b = spine.getBounds();
        const w = Math.max(0, Number(b && b.width));
        const h = Math.max(0, Number(b && b.height));
        if (w > 2 && h > 2) {
          if (Math.abs(w - lastW) < 0.5 && Math.abs(h - lastH) < 0.5) {
            stableFrames++;
          } else {
            stableFrames = 0;
          }
          lastW = w; lastH = h;
          if (stableFrames >= 1) {
            applyModelSettingsFor(name);
            return;
          }
        }
      } catch {}
      const now = performance.now ? performance.now() : Date.now();
      if (now - start < timeoutMs) {
        requestAnimationFrame(attempt);
      } else {
        try { applyModelSettingsFor(name); } catch {}
      }
    }
    requestAnimationFrame(attempt);
  }

  function applyAnimSpeedLive() {
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    if (!cfg) return;
    const spine = getSpineForCharacter(name);
    const app = apps.get(name);
    const speed = Math.max(0.1, Number(cfg.animSpeed || 1.0)) * GLOBAL_SPEED_SCALE;
    try {
      // Prefer state timeScale if available (per-anim speed)
      if (spine && spine.state) spine.state.timeScale = speed;
      // Also scale update tick rate as a fallback
      if (app && app.ticker) {
        app.ticker.speed = speed; // Pixi v6 supports ticker.speed
      }
    } catch {}
  }

  // Bind sliders
  $(document).on('input', '#spine_model_scale', function(){
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    if (!cfg) return;
    cfg.scale = Number($(this).val());
    $('#spine_model_scale_value').text(cfg.scale);
    saveSettingsDebounced();
    applyModelSettingsFor(name);
  });
  $(document).on('input', '#spine_model_x', function(){
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    if (!cfg) return;
    cfg.x = Number($(this).val());
    $('#spine_model_x_value').text(cfg.x);
    saveSettingsDebounced();
    applyModelSettingsFor(name);
  });
  $(document).on('input', '#spine_model_y', function(){
    const name = String($('#spine_character_select').val() || '');
    const cfg = getModelCfg(name);
    if (!cfg) return;
    cfg.y = Number($(this).val());
    $('#spine_model_y_value').text(cfg.y);
    saveSettingsDebounced();
    applyModelSettingsFor(name);
  });
  $(document).on('input', '#spine_anim_speed', function(){
    const cfg = getModelCfg(String($('#spine_character_select').val() || ''));
    if (!cfg) return;
    cfg.animSpeed = Number($(this).val());
    $('#spine_anim_speed_value').text(cfg.animSpeed);
    saveSettingsDebounced();
    applyAnimSpeedLive();
  });

  // Idle/Starter blocks rendering (no after-animation, multi-motion like expressions)
  function renderIdleStarterBlocks() {

    const name = String($('#spine_character_select').val() || '');
    const list = getAnimationListFor(name);
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    if (!key) { $('#spine_idle_block').empty(); $('#spine_starter_block').empty(); $('#spine_click_block').empty(); return; }
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    const cfg = s.characterModelsSettings[name][key] = s.characterModelsSettings[name][key] || {};

    function renderBlock(containerId, title, motionsKey, playHandler) {
      const cont = $(containerId);
      cont.empty();
      const block = $('<div class="spine-expression-mapping"></div>');
      const head = $('<div class="spine-param-head"></div>');
      head.append(`<div class="spine-parameter-title">${title}</div>`);
      const headActions = $('<div class="spine-head-actions"></div>');
      const replayBtn = $('<div class="menu_button spine_replay_button" title="Play"><i class="fa-solid fa-play"></i></div>');
      const clearBtn = $('<div class="menu_button menu_button-danger spine_clear_button" title="Clear"><i class="fa-solid fa-trash"></i></div>');
      headActions.append(replayBtn, clearBtn);
      head.append(headActions);
      const body = $('<div class="spine-param-body"></div>');
      const motionsHeader = $('<div class="spine-parameter"></div>');
      motionsHeader.append('<div class="spine-parameter-title">Motions</div>');
      const motionsControls = $('<div class="spine-select-div"></div>');
      const addBtn = $('<div class="menu_button spine_add_button" title="Add motion"><i class="fa-solid fa-plus"></i></div>');
      motionsControls.append(addBtn);
      motionsHeader.append(motionsControls);
      const motionsWrap = $('<div class="spine-motions"></div>');

      function renderMotionsList(selected) {
        motionsWrap.empty();
        const arr = Array.isArray(selected) ? selected : (selected ? [selected] : []);
        if (arr.length === 0) return renderMotionsList(['']);
        for (let i = 0; i < arr.length; i++) {
          const mm = arr[i];
          const rowEl = $('<div class="spine-select-div"></div>');
          const sel = $('<select class="mm-sel"></select>');
          sel.append('<option value="">(none)</option>');
          for (const a of list) sel.append(`<option value="${a}">${a}</option>`);
          sel.val(mm);
          const rm = $('<div class="menu_button spine_delete_button" title="Remove"><i class="fa-solid fa-xmark"></i></div>');
          rowEl.append(sel, rm);
          motionsWrap.append(rowEl);
          sel.on('change', function(){
            const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            cfg[motionsKey] = vals;
            saveSettingsDebounced();
          });
          rm.on('click', function(){
            rowEl.remove();
            const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            cfg[motionsKey] = vals;
            renderMotionsList(vals);
            saveSettingsDebounced();
          });
        }
      }

      const multi = !!(s.allowMultipleMotions);
      const current = Array.isArray(cfg[motionsKey]) ? cfg[motionsKey] : (cfg[motionsKey] ? [cfg[motionsKey]] : []);
      renderMotionsList(multi ? (current.length ? current : ['']) : (current.length ? [current[0]] : ['']));
      if (!multi) addBtn.hide();

      addBtn.on('click', function(){
        const selects = Array.from(motionsWrap.find('.mm-sel'));
        const noneIdx = selects.findIndex(x => !String($(x).val() || ''));
        if (noneIdx !== -1) {
          // If any row is (none), fill the first (none) with the first motion and do not add a new row
          if (list && list.length) {
            $(selects[noneIdx]).val(String(list[0]));
            const valsNow = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            cfg[motionsKey] = valsNow;
            saveSettingsDebounced();
            $(selects[noneIdx]).trigger('change');
          }
          return;
        }
        // Otherwise add a new empty row (none)
        const vals = selects.map(x => String($(x).val() || ''));
        const next = vals.concat('');
        renderMotionsList(next);
        // Persist current values immediately
        cfg[motionsKey] = next.filter(Boolean);
        saveSettingsDebounced();
      });

      replayBtn.on('click', function(){ playHandler(cfg[motionsKey] || [], name); });
      clearBtn.on('click', function(){ cfg[motionsKey] = []; renderMotionsList(['']); saveSettingsDebounced(); });

      body.append(motionsHeader, motionsWrap);
      block.append(head, body);
      cont.append(block);
    }

    function playMotions(motions, character) {
      const spine = getSpineForCharacter(character);
      if (!spine) return;
      const vals = filterValidMotions(spine, motions);
      if (!vals.length) return;
      vals.forEach((m, i) => { try { spine.state.setAnimation(i, m, true); } catch {} });
    }

    renderBlock('#spine_idle_block', 'Idle', 'idleMotions', playMotions);
    renderBlock('#spine_starter_block', 'Starter', 'starterMotions', function(motions, character){
      const spine = getSpineForCharacter(character);
      if (!spine) return;
      const vals = Array.isArray(motions) ? motions.filter(Boolean) : [];
      if (!vals.length) return;
      vals.forEach((m, i) => spine.state.setAnimation(i, m, false));
    });

    // Click block (like expression mapping but global for click)
    (function(){
      const contId = '#spine_click_block';
      const cont = $(contId);
      cont.empty();
      const block = $('<div class="spine-expression-mapping"></div>');
      const head = $('<div class="spine-param-head"></div>');
      head.append('<div class="spine-parameter-title">Click</div>');
      const headActions = $('<div class="spine-head-actions"></div>');
      const replayBtn = $('<div class="menu_button spine_click_replay_btn" title="Replay"><i class="fa-solid fa-play"></i></div>');
      const clearBtn = $('<div class="menu_button menu_button-danger" title="Clear"><i class="fa-solid fa-trash"></i></div>');
      headActions.append(replayBtn, clearBtn);
      head.append(headActions);
      const body = $('<div class="spine-param-body"></div>');

      const behaviorRow = $('<div class="spine-parameter"></div>');
      const behaviorTitle = $('<div class="spine-parameter-title">After animation</div>');
      const behaviorControls = $('<div class="spine-select-div"></div>');
      const behaviorSel = $('<select class="spine-click-behavior"></select>');
      behaviorSel.append('<option value="none">Play once</option>');
      behaviorSel.append('<option value="loop">Loop</option>');
      behaviorSel.append('<option value="idle">Return to idle</option>');
      behaviorControls.append(behaviorSel);
      behaviorRow.append(behaviorTitle, behaviorControls);

      const divider = $('<div class="spine-divider"></div>');

      const motionsHeader = $('<div class="spine-parameter"></div>');
      const motionsTitle = $('<div class="spine-parameter-title">Motions</div>');
      const motionsControls = $('<div class="spine-select-div"></div>');
      const addBtn = $('<div class="menu_button spine_add_button" title="Add motion"><i class="fa-solid fa-plus"></i></div>');
      motionsControls.append(addBtn);
      motionsHeader.append(motionsTitle, motionsControls);

      const motionsWrap = $('<div class="spine-motions"></div>');

      body.append(behaviorRow, divider, motionsHeader, motionsWrap);
      const topDivider = $('<div class="spine-divider"></div>');
      block.append(head, topDivider, body);
      cont.append(block);

      // Load saved
      const clickConf = cfg.clickConfig = cfg.clickConfig || { motion: [], behavior: 'idle' };
      const savedMotions = Array.isArray(clickConf.motion) ? clickConf.motion : (clickConf.motion ? [clickConf.motion] : []);
      behaviorSel.val(clickConf.behavior || 'idle');

      function renderMotionsList(selected) {
        motionsWrap.empty();
        const arr = Array.isArray(selected) ? selected : (selected ? [selected] : []);
        if (arr.length === 0) return renderMotionsList(['']);
        for (let i = 0; i < arr.length; i++) {
          const mm = arr[i];
          const rowEl = $('<div class="spine-select-div"></div>');
          const sel = $('<select class="mm-sel"></select>');
          sel.append('<option value="">(none)</option>');
          for (const a of list) sel.append(`<option value="${a}">${a}</option>`);
          sel.val(mm);
          const rm = $('<div class="menu_button spine_delete_button" title="Remove"><i class="fa-solid fa-xmark"></i></div>');
          rowEl.append(sel, rm);
          motionsWrap.append(rowEl);
          sel.on('change', function(){
            const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            clickConf.motion = vals;
            saveSettingsDebounced();
          });
          rm.on('click', function(){
            rowEl.remove();
            const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            clickConf.motion = vals;
            renderMotionsList(vals);
            saveSettingsDebounced();
          });
        }
      }
      const multi = !!(s.allowMultipleMotions);
      renderMotionsList(multi ? (savedMotions.length ? savedMotions : ['']) : (savedMotions.length ? [savedMotions[0]] : ['']));
      if (!multi) addBtn.hide();

      addBtn.on('click', function(){
        const selects = Array.from(motionsWrap.find('.mm-sel'));
        const noneIdx = selects.findIndex(x => !String($(x).val() || ''));
        if (noneIdx !== -1) {
          if (list && list.length) {
            $(selects[noneIdx]).val(String(list[0]));
            const valsNow = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            clickConf.motion = valsNow;
            saveSettingsDebounced();
            $(selects[noneIdx]).trigger('change');
          }
          return;
        }
        const vals = selects.map(x => String($(x).val() || ''));
        const next = vals.concat('');
        renderMotionsList(next);
        clickConf.motion = next.filter(Boolean);
        saveSettingsDebounced();
      });

      behaviorSel.on('change', function(){
        clickConf.behavior = String($(this).val() || 'none');
        saveSettingsDebounced();
      });

      replayBtn.on('click', function(){
        try {
          const spine = getSpineForCharacter(name);
          if (!spine) return;
          const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
          const mode = String(behaviorSel.val() || 'none');
          if (vals.length === 0) return;
          if (mode === 'loop') {
            vals.forEach((m, i) => spine.state.setAnimation(i, m, true));
          } else if (mode === 'idle') {
            const idleMotions = getIdleMotionsForCharacter(name);
            if (!idleMotions || idleMotions.length === 0) { vals.forEach((m, i) => spine.state.setAnimation(i, m, false)); return; }
            vals.forEach((m, i) => {
              spine.state.setAnimation(i, m, false);
              const idleName = idleMotions[i % idleMotions.length];
              if (spine.state.addAnimation) spine.state.addAnimation(i, idleName, true, 0);
              else setTimeout(() => { try { spine.state.setAnimation(i, idleName, true); } catch {} }, 0);
            });
          } else {
            vals.forEach((m, i) => spine.state.setAnimation(i, m, false));
          }
        } catch {}
      });

      clearBtn.on('click', function(){
        cfg.clickConfig = { motion: [], behavior: 'none' };
        motionsWrap.empty();
        behaviorSel.val('none');
        saveSettingsDebounced();
      });
    })();
  }

  // Animations refresh & replay
  function getAnimationListFor(name) {
    const spine = getSpineForCharacter(name);
    try {
      return spine?.state?.data?.skeletonData?.animations?.map(a => a.name) || [];
    } catch { return []; }
  }

  const CLASSIFY_EXPRESSIONS = [
    'admiration','amusement','anger','annoyance','approval','caring','confusion','curiosity','desire','disappointment','disapproval','disgust','embarrassment','excitement','fear','gratitude','grief','joy','love','nervousness','optimism','pride','realization','relief','remorse','sadness','surprise','neutral'
  ];
  function getExpressions() {
    // Live2D's list mirrored (can be extended later)
    return [
      'admiration','amusement','anger','annoyance','approval','caring','confusion','curiosity','desire','disappointment','disapproval','disgust','embarrassment','excitement','fear','gratitude','grief','joy','love','nervousness','optimism','pride','realization','relief','remorse','sadness','surprise','neutral'
    ];
  }

  function refreshAnimationSelects() {
    const s = extension_settings[extensionName];
    const name = String($('#spine_character_select').val() || '');
    const spine = getSpineForCharacter(name);
    const idleSel = $('#spine_idle_motion_select');
    const starterSel = $('#spine_starter_motion_select');
    idleSel.empty(); starterSel.empty();

    // Always include a (none) option so UI doesn't default to the first animation
    idleSel.append('<option value="">(none)</option>');
    starterSel.append('<option value="">(none)</option>');

    if (!spine) return;
    try {
      const list = spine.state?.data?.skeletonData?.animations?.map(a => a.name) || [];
      for (const anim of list) {
        idleSel.append(`<option value="${anim}">${anim}</option>`);
        starterSel.append(`<option value="${anim}">${anim}</option>`);
      }
      const key = resolveModelKey(s, name);
      const cfg = key ? (s.characterModelsSettings?.[name]?.[key] || {}) : {};
      if (cfg.idleAnimation && list.includes(cfg.idleAnimation)) idleSel.val(cfg.idleAnimation); else idleSel.val('');
      if (cfg.starterAnimation && list.includes(cfg.starterAnimation)) starterSel.val(cfg.starterAnimation); else starterSel.val('');

      // Populate click motions (multi-select)
      const clickSel = $('#spine_click_motions_select');
      clickSel.empty();
      for (const anim of list) clickSel.append(`<option value="${anim}">${anim}</option>`);
      const clicks = Array.isArray(cfg.clickMotions) ? cfg.clickMotions : [];
      for (const cm of clicks) if (list.includes(cm)) clickSel.find(`option[value='${cm}']`).prop('selected', true);
    } catch {}
  }
  // Refresh idle/starter/mapping blocks
  $(document).on('click', '#spine_anims_refresh', function(){
    renderIdleStarterBlocks();
    renderMappingTable();
    updateModelSettingsUi();
  });

  // Enable easy multi-select toggling by click (no Ctrl needed)
  $(document).on('mousedown', '#spine_click_motions_select option', function (e) {
    e.preventDefault();
    const opt = $(this);
    opt.prop('selected', !opt.prop('selected'));
    const sel = opt.parent();
    sel.trigger('change');
    return false;
  });
  // The same single-click multi-select behavior for Expression Mapping motions
  $(document).on('mousedown', '.spine-map-motion option', function (e) {
    e.preventDefault();
    const opt = $(this);
    opt.prop('selected', !opt.prop('selected'));
    const sel = opt.parent();
    sel.trigger('change');
    return false;
  });

  // Save click motions when selection changes
  $(document).on('change', '#spine_click_motions_select', function(){
    const name = String($('#spine_character_select').val() || '');
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    if (!key) return;
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    const cfg = s.characterModelsSettings[name][key] = s.characterModelsSettings[name][key] || {};
    const vals = Array.from($('#spine_click_motions_select').find('option:selected')).map(o => String(o.value || ''));
    cfg.clickMotions = vals;
    saveSettingsDebounced();
  });

  // Replay random click motion
  $(document).on('click', '#spine_click_replay', function(){
    const name = String($('#spine_character_select').val() || '');
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    const cfg = key ? (s.characterModelsSettings?.[name]?.[key] || {}) : {};
    const motions = Array.isArray(cfg.clickMotions) ? cfg.clickMotions.slice() : [];
    const spine = getSpineForCharacter(name);
    if (!spine || motions.length === 0) { try { toastr.warning('Spine: No click motions selected.'); } catch {} return; }
    const pick = motions[Math.floor(Math.random() * motions.length)];
    try {
      spine.state.setAnimation(0, pick, false);
      const idle = cfg.idleAnimation;
      if (idle) {
        // After click finishes, return to idle loop
        const entry = spine.state.getCurrent ? spine.state.getCurrent(0) : null;
        const dur = Math.max(0, entry?.animation?.duration || 0);
        setTimeout(() => { try { spine.state.setAnimation(0, idle, true); } catch {} }, Math.ceil((dur + 0.1) * 1000));
      }
    } catch (e) { try { toastr.error('Spine: Failed to play click motion'); } catch {} }
  });

  $(document).on('change', '#spine_idle_motion_select', function(){
    const name = String($('#spine_character_select').val() || '');
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    if (!key) return;
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    const cfg = s.characterModelsSettings[name][key] = s.characterModelsSettings[name][key] || {};
    cfg.idleAnimation = String($(this).val() || '');
    saveSettingsDebounced();
  });
  $(document).on('click', '#spine_idle_replay', function(){
    const name = String($('#spine_character_select').val() || '');
    const spine = getSpineForCharacter(name);
    const anim = String($('#spine_idle_motion_select').val() || '');
    if (!spine || !anim) return;
    try { spine.state.setAnimation(0, anim, true); } catch (e) { toastr.error('Failed to play animation'); }
  });
  function renderMappingTable() {
    const name = String($('#spine_character_select').val() || '');
    const list = getAnimationListFor(name);
    const table = $('#spine_mapping_table');
    table.empty();

    const s = extension_settings[extensionName];
    const modelKey = resolveModelKey(s, name);
    if (!modelKey) return;
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    s.characterModelsSettings[name][modelKey] = s.characterModelsSettings[name][modelKey] || {};
    const bucket = s.characterModelsSettings[name][modelKey];
    bucket.classifyMapping = bucket.classifyMapping || {};
    const cur = bucket.classifyMapping;

    for (const expr of getExpressions()) {
      const block = $('<div class="spine-expression-mapping"></div>');

      // Head: expression label and actions
      const head = $('<div class="spine-param-head"></div>');
      const headLabel = $(`<div class="spine-parameter-title">${expr}</div>`);
      const headActions = $('<div class="spine-head-actions"></div>');
      const replayBtn = $('<div class="menu_button spine_replay_button" title="Replay"><i class="fa-solid fa-play"></i></div>');
      const clearBtn = $('<div class="menu_button menu_button-danger spine_clear_button" title="Clear"><i class="fa-solid fa-trash"></i></div>');
      headActions.append(replayBtn, clearBtn);
      head.append(headLabel, headActions);

      // Body: After animation (top) and Motions (bottom), Live2D-like parameter rows
      const body = $('<div class="spine-param-body"></div>');

      // After animation row
      const behaviorRow = $('<div class="spine-parameter"></div>');
      const behaviorTitle = $('<div class="spine-parameter-title">After animation</div>');
      const behaviorControls = $('<div class="spine-select-div"></div>');
      const behaviorSel = $('<select class="spine-map-behavior"></select>');
      behaviorSel.append('<option value="none">Play once</option>');
      behaviorSel.append('<option value="loop">Loop</option>');
      behaviorSel.append('<option value="idle">Return to idle</option>');
      behaviorControls.append(behaviorSel);
      behaviorRow.append(behaviorTitle, behaviorControls);

      // Divider
      const divider = $('<div class="spine-divider"></div>');

      // Motions header row (title + add button)
      const motionsHeader = $('<div class="spine-parameter"></div>');
      const motionsTitle = $('<div class="spine-parameter-title">Motions</div>');
      const motionsControls = $('<div class="spine-select-div"></div>');
      const addBtn = $('<div class="menu_button spine_add_button" title="Add motion"><i class="fa-solid fa-plus"></i></div>');
      motionsControls.append(addBtn);
      motionsHeader.append(motionsTitle, motionsControls);

      // Motions list stack
      const motionsWrap = $('<div class="spine-motions"></div>');

      body.append(behaviorRow, divider, motionsHeader, motionsWrap);
      const topDivider = $('<div class="spine-divider"></div>');
      block.append(head, topDivider, body);
      table.append(block);

      // Load saved
      const savedMotion = cur?.[expr]?.motion ?? [];
      const savedMotions = Array.isArray(savedMotion) ? savedMotion : (savedMotion ? [savedMotion] : []);
      const savedBehavior = cur?.[expr]?.behavior || 'idle';
      behaviorSel.val(savedBehavior);

      function renderMotionsList(selected) {
        motionsWrap.empty();
        const arr = Array.isArray(selected) ? selected : (selected ? [selected] : []);
        if (arr.length === 0) {
          // Show a single dropdown with (none) selected
          return renderMotionsList(['']);
        }
        for (let i = 0; i < arr.length; i++) {
          const mm = arr[i];
          const rowEl = $('<div class="spine-select-div"></div>');
          const sel = $('<select class="mm-sel"></select>');
          sel.append('<option value="">(none)</option>');
          for (const a of list) sel.append(`<option value="${a}">${a}</option>`);
          sel.val(mm);
          const rm = $('<div class="menu_button spine_delete_button" title="Remove"><i class="fa-solid fa-xmark"></i></div>');
          rowEl.append(sel, rm);
          motionsWrap.append(rowEl);

          sel.on('change', function(){
            const newArr = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            cur[expr] = cur[expr] || {};
            cur[expr].motion = newArr;
            saveSettingsDebounced();
          });
          rm.on('click', function(){
            rowEl.remove();
            const newArr = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
            cur[expr] = cur[expr] || {};
            cur[expr].motion = newArr;
            renderMotionsList(newArr);
            saveSettingsDebounced();
          });
        }
      }
      const multi = !!(extension_settings[extensionName]?.allowMultipleMotions);
      renderMotionsList(multi ? (savedMotions.length ? savedMotions : ['']) : (savedMotions.length ? [savedMotions[0]] : ['']));
      if (!multi) { try { addBtn.hide(); } catch {} }

      addBtn.on('click', function(){
        const current = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
        const defaultVal = list && list.length ? String(list[0]) : '';
        const next = current.concat(defaultVal);
        renderMotionsList(next);
        // Persist immediately
        cur[expr] = cur[expr] || {};
        cur[expr].motion = next.filter(Boolean);
        saveSettingsDebounced();
      });
      behaviorSel.on('change', function(){
        const val = String($(this).val() || 'none');
        cur[expr] = cur[expr] || {};
        cur[expr].behavior = val;
        saveSettingsDebounced();
      });
      replayBtn.on('click', function(){
        const vals = Array.from(motionsWrap.find('.mm-sel')).map(x => String($(x).val() || '')).filter(Boolean);
        const mode = String(behaviorSel.val() || 'none');
        const spine = getSpineForCharacter(name);
        const cfg = (s.characterModelsSettings?.[name]?.[modelKey]) || {};
        const idleName = String(cfg.idleAnimation || '');
        if (!spine || vals.length === 0) return;
        try {
          if (mode === 'loop') {
            vals.forEach((m, i) => spine.state.setAnimation(i, m, true));
            clearPendingIdle(name);
          } else if (mode === 'idle') {
            const idleMotions = getIdleMotionsForCharacter(name);
            if (!idleMotions || idleMotions.length === 0) { try { toastr.warning('Spine: Idle motion not set.'); } catch {} vals.forEach((m, i) => spine.state.setAnimation(i, m, false)); clearPendingIdle(name); return; }
            clearPendingIdle(name);
            // Play mapped motions, then after max duration clear and set idle (same as play button logic)
            vals.forEach((m, i) => spine.state.setAnimation(i, m, false));
            const durations = vals.map(m => {
              const data = spine?.state?.data?.skeletonData?.animations?.find(a => a.name === m);
              return Math.max(0, data?.duration || 0);
            });
            const maxDur = Math.max(0, ...durations);
            setTimeout(() => { try { spine.state.clearTracks(); idleMotions.forEach((im, i) => spine.state.setAnimation(i, im, true)); } catch {} }, Math.ceil((maxDur + 0.1) * 1000));
          } else {
            vals.forEach((m, i) => spine.state.setAnimation(i, m, false));
            clearPendingIdle(name);
          }
        } catch {}
      });
      clearBtn.on('click', function(){
        cur[expr] = { motion: [], behavior: 'none' };
        motionsWrap.empty();
        behaviorSel.val('none');
        saveSettingsDebounced();
      });
    }
  }

  $(document).on('change', '#spine_starter_motion_select', function(){
    const name = String($('#spine_character_select').val() || '');
    const s = extension_settings[extensionName];
    const key = resolveModelKey(s, name);
    if (!key) return;
    s.characterModelsSettings[name] = s.characterModelsSettings[name] || {};
    const cfg = s.characterModelsSettings[name][key] = s.characterModelsSettings[name][key] || {};
    cfg.starterAnimation = String($(this).val() || '');
    saveSettingsDebounced();
  });
  $(document).on('click', '#spine_starter_replay', function(){
    const name = String($('#spine_character_select').val() || '');
    const spine = getSpineForCharacter(name);
    const anim = String($('#spine_starter_motion_select').val() || '');
    if (!spine || !anim) return;
    try { spine.state.setAnimation(0, anim, false); } catch (e) { toastr.error('Failed to play animation'); }
  });

  // Helper: sync select to current context and refresh UI now and shortly after (to wait for spine attach)
  function syncCharacterSelectToContext() {
    try {
      const chars = getCurrentChatMembers();
      const sel = $('#spine_character_select');
      const ctx = getContext();
      const prefer = String(ctx?.name2 || '');
      if (prefer && chars.includes(prefer)) sel.val(prefer);
      else if (chars.length > 0) sel.val(chars[0]);
    } catch {}
  }
  function refreshUiForCurrentSelection() {
    try { updateModelSettingsUi(); renderIdleStarterBlocks(); renderMappingTable(); refreshSavedModelsList(); } catch {}
  }
  function refreshUiForCurrentSelectionLater(delayMs = 600) {
    refreshUiForCurrentSelection();
    setTimeout(() => { refreshUiForCurrentSelection(); }, delayMs);
  }

  // Events
  eventSource.on(event_types.CHAT_CHANGED, async function(){
    populateCharacters();
    syncCharacterSelectToContext();
    await onChatChanged();
    try { const name = String($('#spine_character_select').val() || ''); if (name) schedulePlayStarterOnce(name, 500, 4000); } catch {}
    refreshUiForCurrentSelectionLater(700);
  });
  eventSource.on(event_types.GROUP_UPDATED, function(){
    populateCharacters();
    syncCharacterSelectToContext();
    refreshContainers();
    try { const name = String($('#spine_character_select').val() || ''); if (name) schedulePlayStarterOnce(name, 500, 4000); } catch {}
    refreshUiForCurrentSelectionLater(700);
  });
  eventSource.on(event_types.MOVABLE_PANELS_RESET, function(){
    populateCharacters();
    syncCharacterSelectToContext();
    refreshContainers();
    refreshUiForCurrentSelectionLater(700);
  });

  // React to new messages with expression classification similar to Live2D
  eventSource.on(event_types.MESSAGE_RECEIVED, async (chat_id) => {
    try {
      const ctx = getContext();
      const msg = ctx.chat[chat_id];
      if (!msg || msg.is_user || msg.is_system) return;
      const character = msg.name;
      const s = extension_settings[extensionName];
      const skey = resolveModelKey(s, character);
      if (!s.enabled || !skey) return;

      const text = msg.mes || '';
      const expression = await classifyText(text);
      const cfg = s.characterModelsSettings?.[character]?.[skey] || {};
      // fallback to 'neutral' if specific not set
      const mapped = cfg.classifyMapping?.[expression]?.motion || cfg.classifyMapping?.neutral?.motion || [];
      const behavior = cfg.classifyMapping?.[expression]?.behavior || 'idle';
      const spine = getSpineForCharacter(character);

      if (spine && (Array.isArray(mapped) ? mapped.length > 0 : !!mapped)) {
        try {
          idleDbg('MESSAGE_RECEIVED mapped', { character, expression, mapped, behavior, idle: cfg.idleAnimation });
          if (behavior === 'loop') {
            const motionsAll = Array.isArray(mapped) ? mapped : [String(mapped)];
            const motions = filterValidMotions(spine, motionsAll);
            if (!motions.length) { spineDbg('No valid motions for loop', { character, mapped }); return; }
            motions.forEach((m, i) => { try { spine.state.setAnimation(i, m, true); } catch {} });
            clearPendingIdle(character);
          } else if (behavior === 'idle') {
            const motionsAll = Array.isArray(mapped) ? mapped : [String(mapped)];
            const motions = filterValidMotions(spine, motionsAll);
            idleDbg('idle behavior start', { character, motions });
            clearPendingIdle(character);
            const idleMotionsAll = getIdleMotionsForCharacter(character);
            const idleMotions = filterValidMotions(spine, idleMotionsAll);
            // Play non-looping motions now, and queue idle immediately for seamless transition
            motions.forEach((m, i) => {
              try { spine.state.setAnimation(i, m, false); } catch {}
              try {
                if (idleMotions && idleMotions.length && spine.state.addAnimation) {
                  const idleName = idleMotions[i % idleMotions.length];
                  spine.state.addAnimation(i, idleName, true, 0);
                }
              } catch {}
            });
            if (idleMotions && idleMotions.length > 0) {
              // Fallback verification at exact motion end (no extra fudge)
              const durations = durationsFor(spine, motions);
              const maxDur = Math.max(0, ...durations);
              setTimeout(() => { try { scheduleIdleLikePlayButton(spine, idleMotions); } catch {} }, Math.ceil(maxDur * 1000));
            } else {
              spineDbg('No valid idle motions; skipping return to idle', { character, idleMotionsAll });
            }
          } else {
            const motionsAll = Array.isArray(mapped) ? mapped : [String(mapped)];
            const motions = filterValidMotions(spine, motionsAll);
            if (!motions.length) { spineDbg('No valid motions for play-once', { character, mapped }); return; }
            motions.forEach((m, i) => { try { spine.state.setAnimation(i, m, false); } catch {} });
            clearPendingIdle(character);
          }
        } catch {}
      } else if (spine && cfg.idleAnimation) {
        try { spine.state.setAnimation(0, cfg.idleAnimation, true); clearPendingIdle(character); } catch {}
      }
    } catch (e) { console.warn('[Spine] MESSAGE_RECEIVED handler failed', e); }
  });

  await loadSettings();
  // Apply pointer events/cursor according to initial drag mode
  try {
    const allowPointer = !!(extension_settings[extensionName]?.dragMode);
    document.querySelectorAll('.spine-canvas-wrapper').forEach(w => {
      w.style.pointerEvents = allowPointer ? 'auto' : 'none';
      const c = w.querySelector('canvas'); if (c) c.style.cursor = allowPointer ? 'grab' : 'default';
    });
  } catch {}

  // Helper: classify text using same approach as Live2D (local/extras)
  async function classifyText(text) {
    const s = extension_settings;
    if (!text) return 'neutral';
    try {
      // translate to English
      if (extension_settings.expressions.translate && typeof globalThis.translate === 'function') {
        text = await globalThis.translate(text, 'en');
      }
      // If extras classifier is installed
      if (s.expressions?.api === 1 /* extras */) {
        const url = new URL(extension_settings.apiUrl || window.location.origin);
        url.pathname = '/api/classify';
        const res = await doExtrasFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'bypass' },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          const data = await res.json();
          const label = data.classification?.[0]?.label || 'neutral';
          if (CLASSIFY_EXPRESSIONS.includes(label)) return label;
        }
      } else {
        // Local transformers (if available)
        const res = await fetch('/api/extra/classify', {
          method: 'POST',
          headers: getRequestHeaders(),
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          const data = await res.json();
          const label = data.classification?.[0]?.label || 'neutral';
          if (CLASSIFY_EXPRESSIONS.includes(label)) return label;
        }
      }
    } catch {}
    return 'neutral';
  }
});
