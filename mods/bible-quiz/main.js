/**
 * Bible Quiz 2.0 mod — main.js
 *
 * Categorized questions with fill-in-the-blank support.
 * Shows question on player pages, answer on judge right/wrong.
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

  function wss() { return global._gameWss; }
  function adminSessions() { return global._gameAdminSessions; }

  api.register({
    ...meta,

    onActivate: (gs) => {
      isActive = true;
      currentQ = null;
      usedIndices = [];
      // Send category list to admin
      broadcastToAdmin({
        type: 'bq_init',
        categories: catLabels,
        total: allQuestions.length,
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
      broadcast({ type: 'bq_state', active: false });
    },

    onRoundStart: (gs) => {
      if (!isActive) return;
      nextQuestion();
    },

    onJudgeRight: (gs) => {
      if (!isActive || !currentQ) return;
      broadcastAnswer(true);
    },

    onJudgeWrong: (gs) => {
      if (!isActive || !currentQ) return;
      broadcastAnswer(false);
    },

    onGameEnd: (gs) => {
      if (!isActive) return;
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
            type: currentQ.type,
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
        });
      },
      // Admin: pick from specific category
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
    },
  });

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
      catIdx: allQuestions[pick].catIdx,
      catName: allQuestions[pick].catName,
      catIcon: allQuestions[pick].catIcon,
    };
    // Send question to all players (no answer!)
    broadcast({
      type: 'bq_question',
      q: currentQ.q,
      type: currentQ.type,
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
    // Pick random unused
    const available = [];
    for (let i = 0; i < allQuestions.length; i++) {
      if (!usedIndices.includes(i)) available.push(i);
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
        catName: currentQ.catName,
        catIcon: currentQ.catIcon,
      },
      total: allQuestions.length,
      used: usedIndices.length,
      answered: usedIndices.length - 1,
      categories: catLabels,
    });
  }

  function broadcastAnswer(correct) {
    broadcast({
      type: 'bq_answer',
      correct,
      q: currentQ.q,
      a: currentQ.a,
      d: currentQ.d,
      type: currentQ.type,
      catName: currentQ.catName,
      catIcon: currentQ.catIcon,
    });
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

  console.log('[BQ] Loaded ' + allQuestions.length + ' questions across ' + categories.length + ' categories');
};
