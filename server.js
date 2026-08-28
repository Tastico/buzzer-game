const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Dependency check (before requiring modules) ──
try { fs.accessSync(path.join(__dirname, 'node_modules', 'express')); }
catch (e) {
  console.error('\n  ❌ Missing dependencies. Run: npm install\n');
  process.exit(1);
}

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const RECONNECT_GRACE_MS = 8000;     // 8s grace for reconnection

const PROFILES_FILE = path.join(__dirname, 'profiles.json');

// ── Persistent player profiles ──
const profiles = new Map(); // profileUuid -> { name, ip, totalScores, gameHistory, firstSeen, lastSeen }

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
      for (const [id, p] of Object.entries(data)) {
        profiles.set(id, p);
      }
      console.log(`[PROFILES] Loaded ${profiles.size} profiles`);
    }
  } catch(e) { console.error('[PROFILES] Load error:', e.message); }
}

// ── Debounced profile saving ──
let profilesDirty = false;
let profilesSaveTimer = null;

function markProfilesDirty() {
  profilesDirty = true;
  if (!profilesSaveTimer) {
    profilesSaveTimer = setTimeout(flushProfiles, 5000);
  }
}

function flushProfiles() {
  profilesSaveTimer = null;
  if (!profilesDirty) return;
  profilesDirty = false;
  try {
    const obj = {};
    for (const [id, p] of profiles) obj[id] = p;
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(obj, null, 2));
  } catch(e) { console.error('[PROFILES] Save error:', e.message); }
}

function getOrCreateProfile(profileUuid, name, ip) {
  if (profiles.has(profileUuid)) {
    const p = profiles.get(profileUuid);
    p.lastSeen = Date.now();
    p.ip = ip;
    if (name) p.name = name;
    if (p.gameScore === undefined) p.gameScore = 0;
    return p;
  }
  const p = {
    id: profileUuid,
    name: name || 'Anonymous',
    ip,
    gamesPlayed: 0,
    correctAnswers: 0,
    wrongAnswers: 0,
    totalScore: 0,
    gameScore: 0,      // Current game session score — survives disconnects
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
  profiles.set(profileUuid, p);
  markProfilesDirty();
  return p;
}

function recordGameResult(profileUuid, isCorrect) {
  const p = profiles.get(profileUuid);
  if (!p) return;
  p.gamesPlayed++;
  if (isCorrect) p.correctAnswers++;
  else p.wrongAnswers++;
  if (isCorrect) p.totalScore++;
  markProfilesDirty();
}

// ── Sessions (in-memory, keyed by profileUuid) ──
const sessions = new Map();          // profileUuid -> { ws, id, ip, name, score, joinedAt, lastPing, profileUuid }
const adminSessions = new Set();
const spectators = new Set();        // ws connections in watch-only mode
const pendingCleanups = new Map();   // profileUuid -> setTimeout handle

const MAX_ROUND_HISTORY = 500;
const JUDGMENT_TIMEOUT_MS = 30000;  // 30s auto-timeout on judgment
const BUZZ_RATE_LIMIT_MS = 500;    // Min ms between buzz attempts
const ADMIN_PASSWORD = process.env.BUZZER_ADMIN_PASSWORD || 'changeme';

// ── Team colors ──
const TEAM_COLORS = [
  '#6366f1', // Indigo
  '#ef4444', // Red
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#a855f7', // Purple
  '#f97316', // Orange
];

let gameState = {
  phase: 'lobby',
  buzzedPlayer: null,
  buzzedAt: null,           // Date.now() when player buzzed
  roundNumber: 0,
  countdownTimer: null,
  countdownRemaining: 0,
  countdownDelay: 0,
  frozen: false,
  roundHistory: [],
  judgmentTimer: null,
  buzzTimerInterval: null,   // 1s interval to broadcast hold time to admin
  buzzOrder: [],             // names in buzz order for the current round (spectator stats)

  // Teams mode
  teamsMode: false,
  teams: [],
};

function trimRoundHistory() {
  if (gameState.roundHistory.length > MAX_ROUND_HISTORY) {
    gameState.roundHistory = gameState.roundHistory.slice(-Math.floor(MAX_ROUND_HISTORY / 2));
  }
}

function clearCountdownTimer() {
  if (gameState.countdownTimer) {
    clearInterval(gameState.countdownTimer);
    gameState.countdownTimer = null;
  }
}

function clearJudgmentTimer() {
  if (gameState.judgmentTimer) {
    clearTimeout(gameState.judgmentTimer);
    gameState.judgmentTimer = null;
  }
}

function clearBuzzTimerInterval() {
  if (gameState.buzzTimerInterval) {
    clearInterval(gameState.buzzTimerInterval);
    gameState.buzzTimerInterval = null;
  }
}

const app = express();
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
// Serve mod files for admin-ui.js and player-ui.js injection
app.use('/mods', express.static(path.join(__dirname, 'mods'), { maxAge: 0, etag: false }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/qr-code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr-code.html')));

app.get('/api/info', (req, res) => {
  res.json({ ip: getLocalIP(), port: PORT, players: getPlayerList(), gameState: getPublicGameState() });
});

app.get('/api/profiles', (req, res) => {
  const data = [];
  for (const [id, p] of profiles) {
    data.push({
      id, name: p.name,
      gamesPlayed: p.gamesPlayed,
      correctAnswers: p.correctAnswers,
      wrongAnswers: p.wrongAnswers,
      totalScore: p.totalScore,
      gameScore: p.gameScore || 0,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
    });
  }
  res.json(data);
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) return iface.address;
  // Fallback: any non-internal IPv4
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return '127.0.0.1';
}

// ── WebSocket ──
const wss = new WebSocketServer({ server });
// Expose for mods to use
global._gameWss = wss;
global._gameAdminSessions = adminSessions;
global._gameSendToPlayer = sendToPlayer;

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.replace(/^::ffff:/, '');
  ws.clientIp = ip;
  ws.role = 'player';
  ws.joined = false;
  ws.playerId = null; // profile UUID

  ws.on('message', (data) => {
    const raw = data.toString();
    console.log(`[MSG] from ${ws.clientIp}: ${raw.substring(0, 200)}`);
    try { handleMessage(ws, JSON.parse(raw)); }
    catch (e) { console.log('[MSG] JSON parse error:', e.message); }
  });

  ws.on('close', () => {
    const closedIp = ws.clientIp || ip;
    const playerId = ws.playerId;
    console.log(`[-] Disconnect: ${closedIp} (player: ${playerId || '?'})`);

    adminSessions.delete(ws);
    spectators.delete(ws);

    if (!playerId) return;

    // Cancel any previous pending cleanup for this playerId
    if (pendingCleanups.has(playerId)) {
      clearTimeout(pendingCleanups.get(playerId));
    }

    // Save profile gameScore before any cleanup
    const session = sessions.get(playerId);
    if (session && session.ws === ws) {
      const p = profiles.get(playerId);
      if (p) {
        p.lastSeen = Date.now();
        if (session.score !== undefined) p.gameScore = session.score;
        markProfilesDirty();
      }
    }

    // Schedule cleanup — only fires if reconnection doesn't happen
    const timerId = setTimeout(() => {
      pendingCleanups.delete(playerId);
      const s = sessions.get(playerId);
      if (s && s.ws === ws) {
        sessions.delete(playerId);
        console.log(`[CLEANUP] Removed session: ${playerId}`);
        if (gameState.buzzedPlayer && gameState.buzzedPlayer.playerId === playerId) {
          clearJudgmentTimer();
          gameState.buzzedPlayer = null;
          gameState.phase = 'active';
          broadcastToAll({ type: 'buzzers_enabled', round: gameState.roundNumber });
          broadcastToAdmin({ type: 'phase_change', phase: 'active', message: 'Buzzer disconnected' });
        }
        broadcastPlayersUpdate();
        broadcastToAdmin({ type: 'player_left', ip: closedIp, name: s.name });
      }
    }, RECONNECT_GRACE_MS);

    pendingCleanups.set(playerId, timerId);
  });
});

// ── Heartbeat ──
// NOTE: Do NOT use ws.ping() / ws.on('pong') — browser WebSocket API
// does NOT auto-respond to server ping frames.
// DO NOT use time-based session expiry — players may watch the
// scoreboard for minutes without sending a message.
// Instead: check if the WebSocket readyState is CLOSING/CLOSED.
const heartbeatTimer = setInterval(() => {
  for (const [playerId, session] of sessions) {
    // Skip if a cleanup timer is already scheduled
    if (pendingCleanups.has(playerId)) continue;
    if (session.ws) {
      const state = session.ws.readyState;
      if (state > 1) {
        // WebSocket is CLOSING (2) or CLOSED (3) — clean up
        console.log(`[HEARTBEAT] Dead WS: ${playerId} (${session.name}), readyState=${state}`);
        sessions.delete(playerId);
        if (gameState.buzzedPlayer && gameState.buzzedPlayer.playerId === playerId) {
          clearJudgmentTimer();
          gameState.buzzedPlayer = null;
          gameState.phase = 'active';
          broadcastToAll({ type: 'buzzers_enabled', round: gameState.roundNumber });
        }
        broadcastPlayersUpdate();
        broadcastToAdmin({ type: 'player_left', ip: session.ip, name: session.name });
      }
    }
  }
}, 10000); // check every 10s

wss.on('close', () => {
  clearInterval(heartbeatTimer);
  clearCountdownTimer();
  clearJudgmentTimer();
  if (profilesSaveTimer) clearTimeout(profilesSaveTimer);
  flushProfiles();
});

// ── Send to a specific player by profileUuid ──
function sendToPlayer(playerId, msg) {
  const session = sessions.get(playerId);
  if (session && session.ws && session.ws.readyState === 1) {
    try { session.ws.send(JSON.stringify(msg)); } catch(e) {}
  }
}

// ── Message Handler ──
function handleMessage(ws, msg) {
  const ip = ws.clientIp;

  switch (msg.type) {

    // ── Admin ──
    case 'admin_register':
      if (msg.password !== ADMIN_PASSWORD) {
        ws.send(JSON.stringify({ type: 'admin_error', message: 'Invalid password' }));
        ws.close();
        return;
      }
      ws.role = 'admin';
      for (const adm of adminSessions) {
        if (adm.clientIp === ip && adm !== ws) {
          try { adm.close(); } catch(e) {}
          adminSessions.delete(adm);
        }
      }
      adminSessions.add(ws);
      ws.send(JSON.stringify({
        type: 'admin_state',
        players: getPlayerList(),
        gameState: getPublicGameState(),
        serverInfo: { ip: getLocalIP(), port: PORT },
        roundHistory: gameState.roundHistory,
        teamsMode: gameState.teamsMode,
        teams: getPublicTeams(),
        mods: modLoader.getMods(),
        activeMod: gameState.activeMod || null,
      }));
      break;

    case 'start_round':
      if (ws.role !== 'admin') return;
      if (gameState.phase !== 'lobby') return;
      if (sessions.size === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'No players connected!' }));
        return;
      }
      // Trigger mod onRoundStart hook (picks next question for Bible Quiz, etc.)
      modLoader.callHook('onRoundStart', gameState);
      clearCountdownTimer();
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      const delay = msg.delay || 0;
      gameState.countdownDelay = delay;
      gameState.roundNumber++;
      gameState.buzzedPlayer = null;
      gameState.buzzedAt = null;
      gameState.buzzOrder = [];
      // Reset spam strikes and wrong-answer lockout for all players on new round
      sessions.forEach(s => { s.buzzStrikes = 0; s.buzzLockedUntil = 0; s.lastBuzzAt = 0; s.wrongThisRound = false; });

      if (delay > 0) {
        gameState.phase = 'countdown';
        gameState.countdownRemaining = delay;
        broadcastToAll({ type: 'countdown', seconds: delay, message: `Round ${gameState.roundNumber} starting!` });
        broadcastToAdmin({ type: 'phase_change', phase: 'countdown', round: gameState.roundNumber });
        gameState.countdownTimer = setInterval(() => {
          gameState.countdownRemaining--;
          if (gameState.countdownRemaining <= 0) {
            clearInterval(gameState.countdownTimer); gameState.countdownTimer = null;
            gameState.phase = 'active';
            broadcastToAll({ type: 'buzzers_enabled', round: gameState.roundNumber });
            broadcastToAdmin({ type: 'phase_change', phase: 'active', round: gameState.roundNumber });
          } else {
            broadcastToAll({ type: 'countdown', seconds: gameState.countdownRemaining });
          }
        }, 1000);
      } else {
        gameState.phase = 'active';
        broadcastToAll({ type: 'buzzers_enabled', round: gameState.roundNumber });
        broadcastToAdmin({ type: 'phase_change', phase: 'active', round: gameState.roundNumber });
      }
      broadcastSpectatorStats();
      break;

    case 'judge_right':
      if (ws.role !== 'admin') return;
      if (!gameState.buzzedPlayer) return;
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      const rightSession = sessions.get(gameState.buzzedPlayer.playerId);
      if (rightSession) {
        // Always add point to player's individual score
        rightSession.score = (rightSession.score || 0) + 1;
        // In teams mode, also recalc team total as sum of all member scores
        if (gameState.teamsMode) {
          recalcAllTeamScores();
        }
        if (rightSession.profileUuid) {
          const p = profiles.get(rightSession.profileUuid);
          if (p) { p.gameScore = rightSession.score; markProfilesDirty(); }
        }
        const entry = {
          round: gameState.roundNumber,
          player: rightSession.name,
          result: 'correct',
          timestamp: Date.now(),
        };
        gameState.roundHistory.push(entry);
        trimRoundHistory();
        if (rightSession.profileUuid) recordGameResult(rightSession.profileUuid, true);

        const teamName = gameState.teamsMode && gameState.buzzedPlayer
          ? findPlayerTeamName(rightSession.profileUuid) : null;
        const teamScore = gameState.teamsMode && teamName
          ? gameState.teams[findPlayerTeam(rightSession.profileUuid)]?.score || 0 : null;

        broadcastToAll({
          type: 'correct_answer',
          player: rightSession.name, ip: rightSession.ip,
          newScore: rightSession.score,
          teamsMode: gameState.teamsMode,
          team: teamName ? { name: teamName, score: teamScore } : null,
          teams: gameState.teamsMode ? getPublicTeams() : undefined,
        });
        broadcastPlayersUpdate();
        if (gameState.teamsMode) broadcastToAll({ type: 'teams_update', teams: getPublicTeams() });
        broadcastToAdmin({
          type: 'judge_result', result: 'correct', player: rightSession.name, newScore: rightSession.score, roundEntry: entry,
          teamsMode: gameState.teamsMode, teams: getPublicTeams(),
        });
      }
      gameState.buzzedPlayer = null;
      gameState.buzzedAt = null;
      gameState.phase = 'lobby';
      broadcastToAll({ type: 'round_end', reason: 'correct' });
      broadcastToAdmin({ type: 'phase_change', phase: 'lobby', round: gameState.roundNumber, message: 'Correct! +1 point' });
      broadcastSpectatorStats();
      // Trigger mod onJudgeRight hook (show answer for Bible Quiz, etc.)
      modLoader.callHook('onJudgeRight', gameState);
      break;

    case 'judge_wrong':
      if (ws.role !== 'admin') return;
      if (!gameState.buzzedPlayer) return;
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      const wrongSession = sessions.get(gameState.buzzedPlayer.playerId);
      const buzzedName = wrongSession?.name || 'Unknown';
      const wrongEntry = {
        round: gameState.roundNumber,
        player: buzzedName,
        result: 'wrong',
        timestamp: Date.now(),
      };
      gameState.roundHistory.push(wrongEntry);
      trimRoundHistory();
      if (wrongSession?.profileUuid) recordGameResult(wrongSession.profileUuid, false);
      // Lock this player from buzzing again this round
      if (wrongSession) wrongSession.wrongThisRound = true;

      broadcastToAll({ type: 'wrong_answer', player: buzzedName });
      broadcastToAdmin({ type: 'judge_result', result: 'wrong', player: buzzedName, roundEntry: wrongEntry });
      broadcastSpectatorStats();
      gameState.buzzedPlayer = null;
      gameState.buzzedAt = null;

      // Use gameState.countdownTimer for the wrong-answer re-enable countdown
      let cd = gameState.countdownDelay > 0 ? gameState.countdownDelay : 3;
      broadcastToAll({ type: 'countdown', seconds: cd, message: 'Wrong! Re-opening buzzers...' });
      gameState.countdownTimer = setInterval(() => {
        cd--;
        if (cd <= 0) {
          clearInterval(gameState.countdownTimer); gameState.countdownTimer = null;
          gameState.phase = 'active';
          broadcastToAll({ type: 'buzzers_enabled', round: gameState.roundNumber });
          broadcastToAdmin({ type: 'phase_change', phase: 'active', message: 'Buzzers re-enabled' });
        } else {
          broadcastToAll({ type: 'countdown', seconds: cd });
        }
      }, 1000);
      // Trigger mod onJudgeWrong hook (show answer for Bible Quiz, etc.)
      modLoader.callHook('onJudgeWrong', gameState);
      break;

    case 'freeze':
      if (ws.role !== 'admin') return;
      gameState.frozen = true; gameState.phase = 'frozen'; gameState.buzzedPlayer = null; gameState.buzzedAt = null;
      clearCountdownTimer();
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      broadcastToAll({ type: 'frozen' });
      broadcastToAdmin({ type: 'phase_change', phase: 'frozen' });
      break;

    case 'unfreeze':
      if (ws.role !== 'admin') return;
      gameState.frozen = false; gameState.phase = 'lobby';
      broadcastToAll({ type: 'unfrozen' });
      broadcastToAdmin({ type: 'phase_change', phase: 'lobby' });
      break;

    case 'update_player':
      if (ws.role !== 'admin') return;
      // Find player by IP (backward compat) or try profileUuid
      let targetSession = null;
      if (msg.profileUuid) {
        targetSession = sessions.get(msg.profileUuid);
      } else if (msg.ip) {
        // Fallback: find by IP
        for (const [id, s] of sessions) {
          if (s.ip === msg.ip) { targetSession = s; break; }
        }
      }
      if (targetSession) {
        if (msg.name) {
          targetSession.name = msg.name;
          // Persist name to profile so it survives reconnect
          if (targetSession.profileUuid) {
            const p = profiles.get(targetSession.profileUuid);
            if (p) { p.name = msg.name; markProfilesDirty(); }
          }
        }
        if (msg.score !== undefined) {
          targetSession.score = parseInt(msg.score) || 0;
          if (targetSession.profileUuid) {
            const p = profiles.get(targetSession.profileUuid);
            if (p) { p.gameScore = targetSession.score; markProfilesDirty(); }
          }
          if (gameState.teamsMode) recalcAllTeamScores();
        }
        broadcastPlayersUpdate();
        if (gameState.teamsMode) {
          broadcastToAll({ type: 'teams_update', teams: getPublicTeams() });
          broadcastToAdmin({ type: 'teams_update', teams: getPublicTeams() });
        }
      }
      break;

    case 'kick_player':
      if (ws.role !== 'admin') return;
      let kickSession = null;
      if (msg.profileUuid) {
        kickSession = sessions.get(msg.profileUuid);
      } else if (msg.ip) {
        for (const [id, s] of sessions) {
          if (s.ip === msg.ip) { kickSession = s; break; }
        }
      }
      if (kickSession && kickSession.ws && kickSession.ws.readyState === 1) {
        try { kickSession.ws.send(JSON.stringify({ type: 'kicked' })); } catch(e) {}
        kickSession.ws.close();
      }
      if (kickSession && kickSession.profileUuid) {
        sessions.delete(kickSession.profileUuid);
      } else if (kickSession) {
        // Fallback: try to locate by ip
        for (const [id, s] of sessions) {
          if (s.ip === msg.ip) { sessions.delete(id); break; }
        }
      }
      broadcastPlayersUpdate();
      break;

    case 'export_scores':
      if (ws.role !== 'admin') return;
      const scoreData = getPlayerList().map(p => `${p.name}: ${p.score} points`).join('\n');
      ws.send(JSON.stringify({ type: 'export_data', data: scoreData, history: gameState.roundHistory }));
      break;

    case 'reset_all':
      if (ws.role !== 'admin') return;
      sessions.forEach(s => {
        s.score = 0;
        if (s.profileUuid) {
          const p = profiles.get(s.profileUuid);
          if (p) { p.gameScore = 0; }
        }
      });
      gameState.roundHistory = []; gameState.roundNumber = 0; gameState.phase = 'lobby'; gameState.buzzedPlayer = null; gameState.buzzedAt = null;
      clearCountdownTimer();
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      markProfilesDirty();
      if (gameState.teamsMode) recalcAllTeamScores();
      broadcastToAll({ type: 'reset', players: getPlayerList() });
      broadcastToAdmin({
        type: 'admin_state',
        players: getPlayerList(),
        gameState: getPublicGameState(),
        roundHistory: gameState.roundHistory,
        teamsMode: gameState.teamsMode,
        teams: getPublicTeams(),
      });
      broadcastToAdmin({ type: 'phase_change', phase: 'lobby', message: 'Game reset' });
      break;

    case 'request_reset':
      // Anyone can request reset back to lobby when game is ended
      if (gameState.phase !== 'ended' && gameState.phase !== 'lobby') return;
      sessions.forEach(s => {
        s.score = 0;
        if (s.profileUuid) {
          const p = profiles.get(s.profileUuid);
          if (p) { p.gameScore = 0; }
        }
      });
      gameState.roundHistory = []; gameState.roundNumber = 0; gameState.phase = 'lobby'; gameState.buzzedPlayer = null; gameState.buzzedAt = null;
      clearCountdownTimer();
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      markProfilesDirty();
      if (gameState.teamsMode) recalcAllTeamScores();
      broadcastToAll({ type: 'reset', players: getPlayerList() });
      broadcastToAdmin({ type: 'phase_change', phase: 'lobby', message: 'Game reset by player' });
      break;

    case 'end_game':
      if (ws.role !== 'admin') return;
      const playerList = getPlayerList();
      let top3 = playerList.slice(0, 3).map(p => ({ name: p.name, score: p.score, rank: 0, teamColor: p.team?.color, teamName: p.team?.name }));
      gameState.phase = 'ended';
      gameState.buzzedPlayer = null;
      gameState.buzzedAt = null;
      clearCountdownTimer();
      clearJudgmentTimer();
      clearBuzzTimerInterval();
      broadcastToAll({ type: 'game_ended', top3 });
      broadcastToAdmin({ type: 'phase_change', phase: 'ended', message: 'Game ended — podium!', top3 });
      modLoader.callHook('onGameEnd', gameState);
      break;

    case 'theme_change':
      if (ws.role !== 'admin') return;
      broadcastToAll({ type: 'theme_change', theme: msg.theme });
      broadcastToAdmin({ type: 'theme_change', theme: msg.theme, applied: true });
      break;

    // ── Player ──
    case 'join':
      if (msg.spectator) {
        ws.role = 'spectator';
        ws.joined = true;
        spectators.add(ws);
        ws.send(JSON.stringify({
          type: 'joined_spectator',
          players: getPlayerList(),
          gameState: getPublicGameState(),
          spectatorStats: getSpectatorStats(),
        }));
        broadcastPlayersUpdate();
        return;
      }
      const name = (msg.name || 'Anonymous').trim().substring(0, 20);
      const profileUuid = msg.profileUuid || ip; // fallback to IP if no UUID

      ws.joined = true;
      ws.playerId = profileUuid;

      // Get or create persistent profile
      const profile = getOrCreateProfile(profileUuid, name, ip);

      // Cancel any pending cleanup for this player
      if (pendingCleanups.has(profileUuid)) {
        clearTimeout(pendingCleanups.get(profileUuid));
        pendingCleanups.delete(profileUuid);
        console.log(`[RECONNECT] Canceled cleanup for: ${profileUuid}`);
      }

      // Restore score from persistent profile
      const restoredScore = profile.gameScore || 0;

      // Replace any existing session for this profileUuid
      const existing = sessions.get(profileUuid);
      if (existing && existing.ws !== ws) {
        // Close old WS if still open
        if (existing.ws && existing.ws.readyState === 1) {
          try { existing.ws.close(); } catch(e) {}
        }
      }

      sessions.set(profileUuid, {
        id: uuidv4(),
        ip,
        name,
        score: restoredScore,
        profileUuid,
        joinedAt: Date.now(),
        lastPing: Date.now(),
        ws,
        buzzStrikes: 0,
        buzzLockedUntil: 0,
        lastBuzzAt: 0,
        wrongThisRound: false,
      });

      ws.send(JSON.stringify({
        type: 'joined',
        player: { ip, name, score: restoredScore, profileUuid },
        gameState: getPublicGameState(),
        players: getPlayerList(),
        activeMod: gameState.activeMod || null,
      }));

      broadcastPlayersUpdate();
      broadcastToAdmin({ type: 'player_joined', ip, name, profileUuid });
      break;

    case 'buzz':
      if (ws.role === 'spectator') {
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: '👁 Spectators cannot buzz' }));
        return;
      }
      if (gameState.phase !== 'active' || gameState.frozen) {
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: 'Not active' }));
        return;
      }
      if (gameState.buzzedPlayer) {
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: 'Already buzzed' }));
        return;
      }
      const playerId = ws.playerId;
      if (!playerId || !sessions.has(playerId)) {
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: 'Join first' }));
        return;
      }
      const buzzer = sessions.get(playerId);

      // Wrong-answer lockout — player cannot buzz again this round
      if (buzzer.wrongThisRound) {
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: '❌ Wrong — wait for next round' }));
        return;
      }

      // Anti-spam: rate limit
      const now = Date.now();
      if (buzzer.buzzLockedUntil && buzzer.buzzLockedUntil > now) {
        const remaining = Math.ceil((buzzer.buzzLockedUntil - now) / 1000);
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: `🔇 Spam locked (${remaining}s)` }));
        return;
      }
      if (buzzer.lastBuzzAt && (now - buzzer.lastBuzzAt) < BUZZ_RATE_LIMIT_MS) {
        buzzer.buzzStrikes = (buzzer.buzzStrikes || 0) + 1;
        if (buzzer.buzzStrikes >= 3) {
          buzzer.buzzLockedUntil = now + 5000; // 5s lockout
          buzzer.buzzStrikes = 0;
          ws.send(JSON.stringify({ type: 'buzz_rejected', reason: '🔇 Spam locked (5s)' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'buzz_rejected', reason: 'Too fast' }));
        return;
      }

      buzzer.lastBuzzAt = now;
      buzzer.buzzStrikes = 0;
      gameState.buzzedPlayer = { ip: buzzer.ip, name: buzzer.name, playerId, profileUuid: buzzer.profileUuid };
      gameState.buzzedAt = now;
      gameState.phase = 'judged';
      gameState.buzzOrder = gameState.buzzOrder || [];
      if (gameState.buzzOrder.length < 12) gameState.buzzOrder.push(buzzer.name);
      modLoader.callHook('onPlayerBuzz', gameState);
      broadcastToAll({ type: 'player_buzzed', player: buzzer.name, ip: buzzer.ip });
      broadcastToAdmin({ type: 'player_buzzed', player: buzzer.name, ip: buzzer.ip, profileUuid: buzzer.profileUuid });
      ws.send(JSON.stringify({ type: 'you_buzzed_first', round: gameState.roundNumber }));
      broadcastSpectatorStats();

      // Start buzzer hold timer — 1s interval, broadcasts elapsed to admin
      clearBuzzTimerInterval();
      gameState.buzzTimerInterval = setInterval(() => {
        if (gameState.phase === 'judged' && gameState.buzzedAt) {
          const elapsed = ((Date.now() - gameState.buzzedAt) / 1000).toFixed(1);
          broadcastToAdmin({ type: 'buzzer_timer', elapsed: parseFloat(elapsed) });
        } else {
          clearBuzzTimerInterval();
        }
      }, 1000);
      break;

    // ── Teams Mode ──
    case 'set_teams_mode':
      if (ws.role !== 'admin') return;
      gameState.teamsMode = msg.enabled;
      if (!msg.enabled) {
        gameState.teams = [];
        // Reset all scores to individual
        sessions.forEach(s => { s.score = 0; });
      }
      broadcastToAll({ type: 'teams_mode', enabled: gameState.teamsMode, teams: getPublicTeams() });
      broadcastToAdmin({ type: 'teams_mode', enabled: gameState.teamsMode, teams: getPublicTeams() });
      break;

    case 'set_teams':
      if (ws.role !== 'admin') return;
      if (!msg.teams || !Array.isArray(msg.teams)) return;
      gameState.teams = msg.teams.map((t, i) => ({
        name: (t.name || 'Team ' + (i + 1)).substring(0, 20),
        color: TEAM_COLORS[i % TEAM_COLORS.length],
        playerIds: Array.isArray(t.playerIds) ? t.playerIds : [],
        score: 0,
      }));
      // Reset team scores
      gameState.teams.forEach(t => t.score = 0);
      recalcAllTeamScores();
      broadcastToAdmin({ type: 'teams_update', teams: getPublicTeams() });
      broadcastToAll({ type: 'teams_update', teams: getPublicTeams() });
      broadcastPlayersUpdate();
      break;

    case 'reset_teams':
      if (ws.role !== 'admin') return;
      gameState.teams = [];
      broadcastToAll({ type: 'teams_update', teams: [] });
      broadcastToAdmin({ type: 'teams_update', teams: [] });
      broadcastPlayersUpdate();
      break;

    case 'set_active_mod':
      if (ws.role !== 'admin') { console.log('[MOD] set_active_mod rejected: not admin'); return; }
      // Check if mod is enabled
      if (msg.modId) {
        const mod = modLoader.getMod(msg.modId);
        if (mod && !mod.enabled) {
          broadcastToAdmin({ type: 'mods_update', mods: modLoader.getMods(), activeMod: gameState.activeMod, error: `Cannot activate disabled mod: ${mod.name}` });
          return;
        }
      }
      const newModId = msg.modId || null;
      console.log('[MOD] set_active_mod:', newModId, '(was:', gameState.activeMod, ')');
      // Deactivate current mod
      if (gameState.activeMod) {
        modLoader.callHook('onDeactivate', gameState);
      }
      gameState.activeMod = newModId;
      // Activate new mod
      if (newModId) {
        modLoader.callHook('onActivate', gameState);
      }
      console.log('[MOD] Broadcasting mods_update');
      broadcastToAdmin({ type: 'mods_update', mods: modLoader.getMods(), activeMod: gameState.activeMod });
      // Tell players which mod is active so they load the player-ui.js
      broadcastToAll({ type: 'mod_active', modId: newModId });
      break;

    case 'enable_mod':
      if (ws.role !== 'admin') return;
      if (modLoader.enableMod(msg.modId, gameState)) {
        broadcastToAdmin({ type: 'mods_update', mods: modLoader.getMods(), activeMod: gameState.activeMod });
      }
      break;

    case 'disable_mod':
      if (ws.role !== 'admin') return;
      if (modLoader.disableMod(msg.modId, gameState)) {
        broadcastToAdmin({ type: 'mods_update', mods: modLoader.getMods(), activeMod: gameState.activeMod });
        // If active mod was deactivated, tell players too
        broadcastToAll({ type: 'mod_active', modId: null });
      }
      break;

    case 'refresh_mods':
      if (ws.role !== 'admin') return;
      modLoader.refreshMods(gameState);
      broadcastToAdmin({ type: 'mods_update', mods: modLoader.getMods(), activeMod: gameState.activeMod });
      broadcastToAll({ type: 'phase_change', phase: gameState.phase, message: 'Mods refreshed' });
      break;

    default:
      // Route to active mod's custom WS handlers
      if (modLoader.routeMessage(msg.type, ws, msg, gameState)) {
        break;
      }
      break;
  }
}

// ── Helpers ──
function getPlayerList() {
  const list = [];
  for (const [pId, session] of sessions) {
    const teamIdx = findPlayerTeam(pId);
    list.push({
      ip: session.ip,
      name: session.name,
      score: session.score || 0,
      profileUuid: session.profileUuid,
      joinedAt: session.joinedAt,
      connected: session.ws && session.ws.readyState === 1,
      team: teamIdx !== null ? {
        name: gameState.teams[teamIdx].name,
        color: gameState.teams[teamIdx].color,
        score: gameState.teams[teamIdx].score || 0,
      } : null,
    });
  }
  list.sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  return list;
}

function getPublicGameState() {
  return {
    phase: gameState.phase,
    roundNumber: gameState.roundNumber,
    buzzedPlayer: gameState.buzzedPlayer
      ? { name: gameState.buzzedPlayer.name, ip: gameState.buzzedPlayer.ip }
      : null,
    buzzedAt: gameState.buzzedAt,
    frozen: gameState.frozen,
    countdownRemaining: gameState.countdownRemaining,
    teamsMode: gameState.teamsMode,
    teams: getPublicTeams(),
    activeMod: gameState.activeMod || null,
  };
}

// ── Teams helpers ──
function findPlayerTeam(profileUuid) {
  if (!gameState.teamsMode || !gameState.teams.length) return null;
  for (let i = 0; i < gameState.teams.length; i++) {
    if (gameState.teams[i].playerIds.includes(profileUuid)) return i;
  }
  return null;
}

function findPlayerTeamName(profileUuid) {
  const idx = findPlayerTeam(profileUuid);
  return idx !== null ? gameState.teams[idx].name : null;
}

function getPublicTeams() {
  return gameState.teams.map(t => ({
    name: t.name,
    color: t.color,
    playerIds: t.playerIds || [],
    score: t.score || 0,
  }));
}

function recalcAllTeamScores() {
  // Sum each player's score to their team. Reset all teams first.
  gameState.teams.forEach(t => t.score = 0);
  for (const [id, session] of sessions) {
    const teamIdx = findPlayerTeam(id);
    if (teamIdx !== null) {
      gameState.teams[teamIdx].score = (gameState.teams[teamIdx].score || 0) + (session.score || 0);
    }
  }
}

function broadcastToAll(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function broadcastToAdmin(msg) {
  const data = JSON.stringify(msg);
  adminSessions.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function broadcastPlayersUpdate() {
  const msg = { type: 'players_update', players: getPlayerList(), gameState: getPublicGameState(), spectatorCount: spectators.size };
  broadcastToAll(msg);
  broadcastToAdmin(msg);
}

// ── Spectator stats ──
function getSpectatorStats() {
  return {
    spectatorCount: spectators.size,
    players: getPlayerList(),
    gameState: getPublicGameState(),
    buzzOrder: gameState.buzzOrder || [],
  };
}

function broadcastSpectatorStats() {
  const msg = { type: 'spectator_stats', ...getSpectatorStats() };
  const data = JSON.stringify(msg);
  spectators.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── Mod system ──
const modLoader = require('./lib/mod-loader');
modLoader.discoverMods();

// ── Start ──
loadProfiles();
server.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       🛎️  BUZZER GAME SERVER         ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Players: http://${ip}:${PORT}        ║`);
  console.log(`  ║  Admin:   http://${ip}:${PORT}/admin  ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
