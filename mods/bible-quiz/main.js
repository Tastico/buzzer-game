/**
 * Bible Quiz 2.0 mod — main.js
 *
 * Categorized questions with fill-in-the-blank, wrong-word and guess-source
 * support. Shows the question on player pages; the answer is revealed ONLY
 * to the player who buzzed (others get a hidden "answered" notice).
 * A 10s answer timer auto-reopens buzzers when the admin does not judge.
 * Theme (category) filter for rounds, plus an Akinator-style character
 * guessing mode with a starter dataset in questions-akinator.json.
 * Integrates with the standard buzzer game flow.
 */
module.exports = function(api, meta) {
  const questions = loadQuestions();
  let categories = questions.categories || [];
  let allQuestions = [];
  let catLabels = [];

  // Flatten categories into a single question pool with category tracking
  categories.forEach((cat, ci) => {
    (cat.questions || []).forEach(q => {
      allQuestions.push({ ...q, catIdx: ci, catName: cat.name, catIcon: cat.icon });
    });
    catLabels.push({ idx: ci, name: cat.name, icon: cat.icon, count: (cat.questions || []).length });
  });

  // State
  let currentQ = null;
  let usedIndices = [];
  let isActive = false;
  let filterCat = null;              // theme filter: null = all categories, else catIdx
  let answerTimer = null;            // 10s answer timeout handle
  let lastBuzz = null;               // { playerId, name } of the current buzzer (server nulls gs.buzzedPlayer before onJudgeRight/Wrong hooks)
  const ANSWER_TIMEOUT_MS = 10000;

  // Akinator mode state
  let akinator = null;               // { candidates, asked, prevCandidates, question, phase, guess }
  const akinatorData = loadAkinator();

  function wss() { return global._gameWss; }
  function adminSessions() { return global._gameAdminSessions; }

  function sendToPlayer(playerId, msg) {
    const fn = global._gameSendToPlayer;
    if (fn) { try { fn(playerId, msg); return true; } catch(e) {} }
    return false;
  }

  function clearAnswerTimer() {
    if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; }
  }

  api.register({
    ...meta,

    onActivate: (gs) => {
      isActive = true;
      currentQ = null;
      usedIndices = [];
      filterCat = null;
      clearAnswerTimer();
      akinator = null;
      broadcastToAdmin({
        type: 'bq_init',
        categories: catLabels,
        total: allQuestions.length,
        filterCat: null,
      });
      broadcast({
        type: 'bq_state',
        active: true,
        hasQuestion: false,
        categories: catLabels,
      });
    },

    onDeactivate: (gs) => {
      isActive = false;
      clearAnswerTimer();
      akinator = null;
      broadcast({ type: 'bq_state', active: false });
    },

    onRoundStart: (gs) => {
      if (!isActive) return;
      clearAnswerTimer();
      lastBuzz = null;
      nextQuestion();
    },

    onPlayerBuzz: (gs) => {
      // Track the buzzer: the server clears gs.buzzedPlayer before the judge hooks
      if (!isActive || !currentQ) return;
      const buzzed = gs.buzzedPlayer;
      if (!buzzed) return;
      lastBuzz = {
        playerId: buzzed.playerId || buzzed.profileUuid,
        name: buzzed.name,
      };
      clearAnswerTimer();
      // 10s answer timer: if the admin does not judge in time, reopen buzzers
      answerTimer = setTimeout(() => {
        answerTimer = null;
        lastBuzz = null;
        if (!gs.buzzedPlayer) return;
        gs.buzzedPlayer = null;
        gs.buzzedAt = null;
        gs.phase = 'lobby';
        broadcast({ type: 'round_end', reason: 'timeout' });
        broadcastToAdmin({ type: 'phase_change', phase: 'lobby', message: '⏰ No answer within 10s, round ended' });
        broadcastToAdmin({ type: 'bq_timeout', message: 'No answer within 10s. Round ended, start the next one.' });
      }, ANSWER_TIMEOUT_MS);
    },

    onJudgeRight: (gs) => {
      if (!isActive || !currentQ) return;
      revealAnswer(true, gs);
    },

    onJudgeWrong: (gs) => {
      if (!isActive || !currentQ) return;
      revealAnswer(false, gs);
    },

    onGameEnd: (gs) => {
      if (!isActive) return;
      clearAnswerTimer();
      akinator = null;
      broadcast({ type: 'bq_state', active: false, gameEnded: true });
    },

    handlers: {
      // Admin: next question
      bq_next: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        nextQuestion();
      },
      // Resend current question info
      bq_current: (ws, msg, gs) => {
        if (ws.role === 'admin') {
          sendCurrentToAdmin();
        } else if (currentQ) {
          // Player requesting sync — send question (no answer!)
          ws.send(JSON.stringify({
            type: 'bq_question',
            q: currentQ.q,
            qType: currentQ.type,
            options: currentQ.options || [],
            catName: currentQ.catName,
            catIcon: currentQ.catIcon,
            index: usedIndices.length,
            total: allQuestions.length,
          }));
          // Also send bq_state so player knows mod is active
          ws.send(JSON.stringify({ type: 'bq_state', active: true, hasQuestion: !!currentQ }));
        } else {
          // No question yet, just send state
          ws.send(JSON.stringify({ type: 'bq_state', active: true, hasQuestion: false }));
        }
      },
      // Admin: reset question pool
      bq_reset: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        usedIndices = [];
        currentQ = null;
        broadcast({ type: 'bq_reset', message: 'Question pool reset!' });
        broadcastToAdmin({
          type: 'bq_status',
          current: null,
          total: allQuestions.length,
          used: 0,
          categories: catLabels,
          filterCat,
        });
      },
      // Admin: pick from specific category (one-off)
      bq_pick_category: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        const catIdx = msg.catIdx;
        if (catIdx === undefined || catIdx < 0 || catIdx >= categories.length) return;
        // Filter unused questions from this category
        const available = [];
        for (let i = 0; i < allQuestions.length; i++) {
          if (allQuestions[i].catIdx === catIdx && !usedIndices.includes(i)) {
            available.push(i);
          }
        }
        if (available.length === 0) {
          broadcastToAdmin({ type: 'bq_error', message: 'No more questions in that category!' });
          return;
        }
        const pick = available[Math.floor(Math.random() * available.length)];
        setCurrent(pick);
      },
      // Admin: set persistent theme filter for rounds (null = all)
      bq_set_filter: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        const catIdx = msg.catIdx;
        if (catIdx === null || catIdx === undefined || catIdx === '') {
          filterCat = null;
        } else {
          const idx = parseInt(catIdx, 10);
          if (isNaN(idx) || idx < 0 || idx >= categories.length) return;
          filterCat = idx;
        }
        const label = filterCat === null ? 'All themes' : (catLabels[filterCat] ? catLabels[filterCat].name : '?');
        broadcastToAdmin({ type: 'bq_filter_set', filterCat, label });
        broadcastToAdmin({ type: 'bq_status', current: currentQ ? {
          q: currentQ.q, a: currentQ.a, d: currentQ.d, type: currentQ.type,
          options: currentQ.options || [], catName: currentQ.catName, catIcon: currentQ.catIcon,
        } : null, total: allQuestions.length, used: usedIndices.length, categories: catLabels, filterCat });
        broadcast({ type: 'bq_filter_notice', label });
      },
      // ── Akinator mode ──
      bq_akinator_start: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        akinatorStart();
      },
      bq_akinator_stop: (ws, msg, gs) => {
        if (ws.role !== 'admin') return;
        akinatorStop();
      },
      bq_akinator_answer: (ws, msg, gs) => {
        if (!akinator || akinator.phase !== 'playing') return;
        akinatorAnswer(!!msg.yes);
      },
      bq_akinator_confirm: (ws, msg, gs) => {
        if (!akinator || akinator.phase !== 'guess') return;
        akinatorConfirm(!!msg.correct);
      },
    },
  });

  // ── Akinator ──

  function loadAkinator() {
    try {
      const fs = require('fs');
      const path = require('path');
      const qPath = path.join(__dirname, 'questions-akinator.json');
      if (fs.existsSync(qPath)) {
        const data = JSON.parse(fs.readFileSync(qPath, 'utf8'));
        if (data.characters && data.questions && data.characters.length > 1) {
          return data;
        }
        console.error('[BQ] Akinator dataset too small');
      }
    } catch (e) {
      console.error('[BQ] Failed to load akinator dataset:', e.message);
    }
    return null;
  }

  function akinatorStart() {
    if (!akinatorData) {
      broadcastToAdmin({ type: 'bq_error', message: 'Akinator dataset not available!' });
      return;
    }
    clearAnswerTimer();
    akinator = {
      candidates: akinatorData.characters.map((c, i) => i),
      asked: new Set(),
      prevCandidates: null,
      question: null,
      phase: 'playing',
      guess: null,
    };
    broadcast({ type: 'bq_akinator_state', active: true });
    broadcastToAdmin({ type: 'bq_akinator_admin', active: true, message: 'Akinator started. Players answer yes/no!' });
    akinatorNext();
  }

  function akinatorStop() {
    if (!akinator) return;
    akinator = null;
    broadcast({ type: 'bq_akinator_state', active: false });
    broadcastToAdmin({ type: 'bq_akinator_admin', active: false, message: 'Akinator stopped.' });
  }

  function pickQuestion(cands, asked) {
    let best = null;
    let bestScore = -1;
    for (const q of akinatorData.questions) {
      if (asked.has(q.id)) continue;
      let yes = 0;
      for (const i of cands) if (akinatorData.characters[i].traits[q.trait]) yes++;
      const no = cands.length - yes;
      if (yes === 0 || no === 0) continue; // no information
      const score = 1 - Math.abs(yes - no) / cands.length;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best;
  }

  function akinatorNext() {
    if (!akinator) return;
    const best = pickQuestion(akinator.candidates, akinator.asked);
    if (akinator.candidates.length === 1) return akinatorGuess(true);
    if (akinator.asked.size >= 12) return akinatorGuess(false);
    if (!best) return akinatorGuess(false);
    akinator.question = best;
    akinator.asked.add(best.id);
    const msg = {
      type: 'bq_akinator_question',
      text: best.text,
      remaining: akinator.candidates.length,
      questionNum: akinator.asked.size,
    };
    broadcast(msg);
    broadcastToAdmin({
      type: 'bq_akinator_admin',
      question: best.text,
      remaining: akinator.candidates.length,
      candidates: akinator.candidates.map(i => akinatorData.characters[i].name),
    });
  }

  function akinatorAnswer(yes) {
    if (!akinator || akinator.phase !== 'playing' || !akinator.question) return;
    akinator.prevCandidates = akinator.candidates.slice();
    const trait = akinator.question.trait;
    akinator.candidates = akinator.candidates.filter(i => (akinatorData.characters[i].traits[trait] === true) === yes);
    if (akinator.candidates.length === 0) {
      // Inconsistent answers: fall back to previous set and guess with low confidence
      akinator.candidates = akinator.prevCandidates;
      return akinatorGuess(false, true);
    }
    akinatorNext();
  }

  function akinatorGuess(confident, confused) {
    if (!akinator) return;
    const idx = akinator.candidates[Math.floor(Math.random() * akinator.candidates.length)];
    const ch = akinatorData.characters[idx];
    akinator.phase = 'guess';
    akinator.guess = idx;
    const msg = {
      type: 'bq_akinator_guess',
      name: ch.name,
      hint: ch.hint || '',
      confident: !!confident && !confused,
      confused: !!confused,
    };
    broadcast(msg);
    broadcastToAdmin({
      type: 'bq_akinator_admin',
      guess: ch.name,
      hint: ch.hint || '',
      confident: msg.confident,
      confused: msg.confused,
    });
  }

  function akinatorConfirm(correct) {
    if (!akinator || akinator.phase !== 'guess') return;
    if (correct) {
      const name = akinatorData.characters[akinator.guess].name;
      broadcast({ type: 'bq_akinator_done', name, won: true });
      broadcastToAdmin({ type: 'bq_akinator_admin', done: true, won: true, name });
      akinator = null;
      return;
    }
    // Wrong guess: eliminate the character and keep going if possible
    akinator.candidates = akinator.candidates.filter(i => i !== akinator.guess);
    if (akinator.candidates.length === 0) {
      broadcast({ type: 'bq_akinator_done', won: false, message: 'Akinator gives up! You win!' });
      broadcastToAdmin({ type: 'bq_akinator_admin', done: true, won: false, message: 'Akinator gives up!' });
      akinator = null;
      return;
    }
    akinator.phase = 'playing';
    akinator.question = null;
    akinatorNext();
  }

  // ── Helpers ──

  function loadQuestions() {
    try {
      const fs = require('fs');
      const path = require('path');
      const qPath = path.join(__dirname, 'questions.json');
      if (fs.existsSync(qPath)) {
        return JSON.parse(fs.readFileSync(qPath, 'utf8'));
      }
    } catch (e) {
      console.error('[BQ] Failed to load questions:', e.message);
    }
    return { categories: [] };
  }

  function setCurrent(pick) {
    usedIndices.push(pick);
    currentQ = {
      index: pick,
      q: allQuestions[pick].q,
      a: allQuestions[pick].a,
      d: allQuestions[pick].d,
      type: allQuestions[pick].type || 'standard',
      options: allQuestions[pick].options || [],
      catIdx: allQuestions[pick].catIdx,
      catName: allQuestions[pick].catName,
      catIcon: allQuestions[pick].catIcon,
    };
    // Send question to all players (no answer!)
    broadcast({
      type: 'bq_question',
      q: currentQ.q,
      qType: currentQ.type,
      options: currentQ.options,
      catName: currentQ.catName,
      catIcon: currentQ.catIcon,
      index: usedIndices.length,
      total: allQuestions.length,
    });
    // Send full details to admin
    sendCurrentToAdmin();
  }

  function nextQuestion() {
    if (allQuestions.length === 0) {
      broadcastToAdmin({ type: 'bq_error', message: 'No questions loaded!' });
      return;
    }
    // Reset pool if exhausted
    if (usedIndices.length >= allQuestions.length) {
      usedIndices = [];
      broadcast({ type: 'bq_pool_reset', message: 'All questions asked! Resetting pool.' });
    }
    // Pick random unused, respecting the theme filter
    const available = [];
    for (let i = 0; i < allQuestions.length; i++) {
      if (!usedIndices.includes(i) && (filterCat === null || allQuestions[i].catIdx === filterCat)) {
        available.push(i);
      }
    }
    if (available.length === 0) {
      const msg = filterCat === null
        ? 'No questions loaded!'
        : 'No more questions in the selected theme!';
      broadcastToAdmin({ type: 'bq_error', message: msg });
      return;
    }
    const pick = available[Math.floor(Math.random() * available.length)];
    setCurrent(pick);
  }

  function sendCurrentToAdmin() {
    if (!currentQ) {
      broadcastToAdmin({
        type: 'bq_status',
        current: null,
        total: allQuestions.length,
        used: usedIndices.length,
        categories: catLabels,
        filterCat,
      });
      return;
    }
    broadcastToAdmin({
      type: 'bq_status',
      current: {
        q: currentQ.q,
        a: currentQ.a,
        d: currentQ.d,
        type: currentQ.type,
        options: currentQ.options,
        catName: currentQ.catName,
        catIcon: currentQ.catIcon,
      },
      total: allQuestions.length,
      used: usedIndices.length,
      answered: usedIndices.length - 1,
      categories: catLabels,
      filterCat,
    });
  }

  function revealAnswer(correct, gs) {
    if (!isActive || !currentQ) return;
    clearAnswerTimer();
    // The server clears gs.buzzedPlayer before these hooks fire; use our own record
    const buzzed = gs.buzzedPlayer || lastBuzz;
    const winnerId = buzzed && (buzzed.playerId || buzzed.profileUuid);
    lastBuzz = null;

    // Full answer payload: only the winner gets it
    const fullPayload = {
      type: 'bq_answer',
      correct,
      q: currentQ.q,
      a: currentQ.a,
      d: currentQ.d,
      qType: currentQ.type,
      options: currentQ.options || [],
      catName: currentQ.catName,
      catIcon: currentQ.catIcon,
    };
    const delivered = winnerId ? sendToPlayer(winnerId, fullPayload) : false;
    if (!delivered) {
      // Winner disconnected or sendToPlayer unavailable: fall back to broadcast
      broadcast(fullPayload);
    } else {
      // Everyone else gets a hidden notice without the answer content
      broadcast({
        type: 'bq_answer_hidden',
        correct,
        q: currentQ.q,
        catName: currentQ.catName,
        catIcon: currentQ.catIcon,
        revealTo: buzzed ? buzzed.name : '',
      });
    }
    // Keep admin in sync
    sendCurrentToAdmin();
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    const ws = wss();
    if (ws) {
      ws.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
    }
  }

  function broadcastToAdmin(msg) {
    const data = JSON.stringify(msg);
    const admins = adminSessions();
    if (admins) {
      admins.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
    }
  }

  console.log('[BQ] Loaded ' + allQuestions.length + ' questions across ' + categories.length + ' categories'
    + (akinatorData ? ' + ' + akinatorData.characters.length + ' akinator characters' : ' (no akinator dataset)'));
};
