/**
 * mod-loader.js — Minecraft-style drag-and-drop mod system
 *
 * Scans `mods/` directory at startup, auto-discovers mod folders.
 * Each mod is a folder with mod.json + main.js (server-side).
 * Optionally: admin-ui.js (admin panel) and player-ui.js (player page).
 *
 * Mods register via ModAPI.register({ ... }) in their main.js.
 */

const fs = require('fs');
const path = require('path');

const MODS_DIR = path.join(__dirname, '..', 'mods');
let mods = [];        // { id, name, version, description, icon, ...serverAPI }
let modById = {};

// ── Mod API (what's exposed to main.js) ──
const ModAPI = {
  _hooks: {
    onActivate: [],
    onDeactivate: [],
    onRoundStart: [],
    onPlayerBuzz: [],
    onJudgeRight: [],
    onJudgeWrong: [],
    onGameEnd: [],
    onAdminMessage: {},
    onPlayerMessage: {},
  },

  /**
   * Register a mod. Called from mod's main.js.
   */
  register(spec) {
    const id = spec.id;
    if (!id || modById[id]) {
      console.error(`[MODS] Invalid or duplicate mod id: ${id}`);
      return;
    }

    const mod = {
      id,
      name: spec.name || id,
      version: spec.version || '1.0',
      description: spec.description || '',
      icon: spec.icon || '🎮',
      enabled: spec.enabled !== undefined ? spec.enabled : true,
    };

    // Remember the main.js path so refreshMods can unload it
    if (spec._mainPath) {
      mod._mainPath = spec._mainPath;
    }

    // Register lifecycle hooks
    const hooks = ModAPI._hooks;
    if (typeof spec.onActivate === 'function') hooks.onActivate.push({ id, fn: spec.onActivate });
    if (typeof spec.onDeactivate === 'function') hooks.onDeactivate.push({ id, fn: spec.onDeactivate });
    if (typeof spec.onRoundStart === 'function') hooks.onRoundStart.push({ id, fn: spec.onRoundStart });
    if (typeof spec.onPlayerBuzz === 'function') hooks.onPlayerBuzz.push({ id, fn: spec.onPlayerBuzz });
    if (typeof spec.onJudgeRight === 'function') hooks.onJudgeRight.push({ id, fn: spec.onJudgeRight });
    if (typeof spec.onJudgeWrong === 'function') hooks.onJudgeWrong.push({ id, fn: spec.onJudgeWrong });
    if (typeof spec.onGameEnd === 'function') hooks.onGameEnd.push({ id, fn: spec.onGameEnd });

    // Register custom WS message handlers (server-side)
    if (spec.handlers && typeof spec.handlers === 'object') {
      hooks.onAdminMessage[id] = spec.handlers;
      hooks.onPlayerMessage[id] = spec.handlers;
    }

    // Store admin-ui.js and player-ui.js paths for serving
    mod.hasAdminUI = spec.hasAdminUI || false;
    mod.hasPlayerUI = spec.hasPlayerUI || false;

    mods.push(mod);
    modById[id] = mod;
    console.log(`[MODS] Registered: ${mod.icon} ${mod.name} (${id})`);
  },

  /**
   * Call a lifecycle hook across all mods. Hooks run in registration order.
   * If a hook returns false, it can veto the action (e.g. onPlayerBuzz).
   */
  callHook(hookName, ...args) {
    const hooks = ModAPI._hooks[hookName];
    if (!hooks) return true;
    let result = true;
    for (const { id, fn } of hooks) {
      try {
        const r = fn(...args);
        if (r === false) result = false;
      } catch (e) {
        console.error(`[MODS] Error in ${id}.${hookName}:`, e.message);
      }
    }
    return result;
  },

  /**
   * Route a WS message to the active mod's custom handlers.
   * Returns true if handled, false if no handler matched.
   */
  routeMessage(type, ws, msg, gameState) {
    const activeId = gameState.activeMod || null;
    if (!activeId) return false;
    const handlers = ModAPI._hooks.onAdminMessage[activeId] || ModAPI._hooks.onPlayerMessage[activeId];
    if (!handlers || typeof handlers[type] !== 'function') return false;
    try {
      handlers[type](ws, msg, gameState);
      return true;
    } catch (e) {
      console.error(`[MODS] Error routing ${type} to ${activeId}:`, e.message);
      return false;
    }
  },
};

// ── Mod enable/disable/refresh ──

/**
 * Enable a mod by ID.
 */
function enableMod(id, gameState) {
  const mod = modById[id];
  if (!mod) return false;
  mod.enabled = true;
  console.log(`[MODS] Enabled mod: ${mod.name} (${id})`);
  if (gameState && gameState.activeMod === id) {
    callHook('onActivate', gameState);
  }
  return true;
}

/**
 * Disable a mod by ID. If it's the active mod, deactivate it first.
 */
function disableMod(id, gameState) {
  const mod = modById[id];
  if (!mod) return false;
  mod.enabled = false;
  console.log(`[MODS] Disabled mod: ${mod.name} (${id})`);
  // Deactivate if it's the active mod
  if (gameState && gameState.activeMod === id) {
    callHook('onDeactivate', gameState);
    gameState.activeMod = null;
  }
  return true;
}

/**
 * Re-scan the mods/ directory and reload all mods.
 * Clears existing mod registrations and re-discovers everything.
 * Returns the new mod list.
 */
function refreshMods(gameState) {
  // Deactivate active mod first
  if (gameState && gameState.activeMod) {
    callHook('onDeactivate', gameState);
    gameState.activeMod = null;
  }
  // Wipe module cache for mod main.js files
  for (const id in modById) {
    const mod = modById[id];
    if (mod._mainPath) {
      delete require.cache[require.resolve(mod._mainPath)];
    }
  }
  // Clear all state
  Object.keys(ModAPI._hooks).forEach(k => {
    if (Array.isArray(ModAPI._hooks[k])) {
      ModAPI._hooks[k] = [];
    } else if (typeof ModAPI._hooks[k] === 'object') {
      ModAPI._hooks[k] = {};
    }
  });
  mods = [];
  modById = {};
  // Re-discover
  discoverMods();
  console.log(`[MODS] Refreshed: ${mods.length} mod(s) loaded`);
  return mods;
}

// ── Mod discovery ──
function discoverMods() {
  if (!fs.existsSync(MODS_DIR)) {
    fs.mkdirSync(MODS_DIR, { recursive: true });
    console.log('[MODS] Created mods/ directory');
    return;
  }

  const entries = fs.readdirSync(MODS_DIR, { withFileTypes: true });
  const modFolders = entries.filter(e => e.isDirectory());

  for (const folder of modFolders) {
    const modPath = path.join(MODS_DIR, folder.name);
    const modJsonPath = path.join(modPath, 'mod.json');
    const mainJsPath = path.join(modPath, 'main.js');
    const adminUiPath = path.join(modPath, 'admin-ui.js');
    const playerUiPath = path.join(modPath, 'player-ui.js');

    if (!fs.existsSync(modJsonPath)) {
      console.log(`[MODS] Skipping ${folder.name}: no mod.json`);
      continue;
    }

    // Read mod.json for metadata
    let modMeta;
    try {
      modMeta = JSON.parse(fs.readFileSync(modJsonPath, 'utf8'));
    } catch (e) {
      console.error(`[MODS] Skipping ${folder.name}: invalid mod.json (${e.message})`);
      continue;
    }

    // Set flags before loading main.js so register() can use them
    modMeta.hasAdminUI = fs.existsSync(adminUiPath);
    modMeta.hasPlayerUI = fs.existsSync(playerUiPath);

    // Load main.js — it calls ModAPI.register()
    if (fs.existsSync(mainJsPath)) {
      try {
        // Pass ModAPI to the mod's scope
        modMeta._mainPath = mainJsPath;
        const modExports = require(mainJsPath);
        if (typeof modExports === 'function') {
          modExports(ModAPI, modMeta);
        }
      } catch (e) {
        console.error(`[MODS] Error loading ${folder.name}/main.js:`, e.message);
      }
    } else {
      // Register with just metadata (admin-ui only mods)
      ModAPI.register(modMeta);
    }
  }

  if (mods.length === 0) {
    console.log('[MODS] No mods found');
  } else {
    console.log(`[MODS] Loaded ${mods.length} mod(s): ${mods.map(m => m.name).join(', ')}`);
  }
}

// ── Exports ──
module.exports = {
  discoverMods,
  ModAPI,
  callHook: ModAPI.callHook.bind(ModAPI),
  routeMessage: ModAPI.routeMessage.bind(ModAPI),
  getMods: () => mods,
  getMod: (id) => modById[id],
  getActiveMod: (gameState) => gameState.activeMod ? modById[gameState.activeMod] : null,
  setActiveMod: (id, gameState) => { gameState.activeMod = id; },
  enableMod,
  disableMod,
  refreshMods,
};
