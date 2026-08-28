/**
 * Bible Quiz — player-ui.js
 *
 * Injected into the mod-area when Bible Quiz mod is active.
 * Shows the current question (standard / fill / wrong-word / guess-source),
 * the winner-only answer reveal, and the Akinator yes/no flow.
 * Communicates via window.onModMessage(msg).
 */

(function() {
  'use strict';

  var container = document.getElementById('mod-area');
  if (!container) return;

  var state = {
    hasQuestion: false,
    showAnswer: false,
    answerHidden: false,
    currentQ: null,
    currentA: null,
    currentD: null,
    currentType: 'standard',
    catName: '',
    catIcon: '',
    questionNum: 0,
    totalQuestions: 0,
    active: false,
    gameEnded: false,
    lastCorrect: undefined,

    // Akinator
    akinatorActive: false,
    akinatorQuestion: null,
    akinatorRemaining: 0,
    akinatorNum: 0,
    akinatorGuess: null,
    akinatorConfident: false,
    akinatorConfused: false,
    akinatorDone: null,
  };

  function typeLabel(t) {
    switch (t) {
      case 'fill': return 'Fill in the blank';
      case 'wrong_word': return 'Find the wrong word';
      case 'guess_source': return 'Guess the verse source';
      default: return '';
    }
  }

  // ── Render ──
  function render() {
    if (!state.active || state.gameEnded) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    container.style.padding = '16px';
    container.style.textAlign = 'center';

    // Akinator takes over the panel while active
    if (state.akinatorActive) {
      renderAkinator();
      return;
    }
    if (state.akinatorDone) {
      renderAkinatorDone();
      return;
    }

    if (!state.hasQuestion || !state.currentQ) {
      container.innerHTML =
        '<div style="padding:20px;color:var(--text2);font-size:14px">' +
          '<span style="font-size:32px;display:block;margin-bottom:8px">📖</span>' +
          'Waiting for the next question...' +
        '</div>';
      return;
    }

    var catTag = state.catIcon && state.catName
      ? '<span style="font-size:11px;background:rgba(108,99,255,.1);color:#6c63ff;padding:3px 10px;border-radius:999px;font-weight:600;display:inline-block;margin-bottom:8px">' +
        state.catIcon + ' ' + state.catName + '</span>'
      : '';

    var typeTag = typeLabel(state.currentType)
      ? '<div style="font-size:10px;color:var(--text3);margin-bottom:6px;letter-spacing:.4px;text-transform:uppercase">' + typeLabel(state.currentType) + '</div>'
      : '';

    var questionText = state.currentType === 'fill'
      ? state.currentQ.replace(/___/g, '<span style="display:inline-block;min-width:80px;border-bottom:2px dashed var(--accent);padding:0 4px;color:var(--accent);font-weight:700">______</span>')
      : state.currentQ;

    var answerHtml = '';
    if (state.showAnswer && state.currentA) {
      var resultIcon = state.lastCorrect !== undefined
        ? (state.lastCorrect ? '✅' : '❌')
        : '💡';
      answerHtml =
        '<div style="margin-top:14px;padding:14px;background:rgba(108,99,255,.06);border-radius:10px;font-size:13px;animation:fadeIn .3s ease-out">' +
          '<div style="font-size:24px;margin-bottom:6px">' + resultIcon + '</div>' +
          '<div style="color:var(--text);font-weight:600;margin-bottom:4px">' + escHtml(state.currentA) + '</div>' +
          (state.currentD ? '<div style="font-size:11px;color:var(--text3)">📖 ' + escHtml(state.currentD) + '</div>' : '') +
        '</div>';
    } else if (state.answerHidden) {
      // Answer was revealed to the winner only; everyone else gets a notice
      var hiddenIcon = state.lastCorrect !== undefined ? (state.lastCorrect ? '✅' : '❌') : '🔒';
      answerHtml =
        '<div style="margin-top:14px;padding:14px;background:rgba(108,99,255,.06);border-radius:10px;font-size:13px;animation:fadeIn .3s ease-out">' +
          '<div style="font-size:24px;margin-bottom:6px">' + hiddenIcon + '</div>' +
          '<div style="color:var(--text3);font-size:12px">Answer revealed to ' + escHtml(state.revealTo || 'the winner') + ' only</div>' +
          (state.currentD ? '<div style="font-size:11px;color:var(--text3);margin-top:4px">📖 ' + escHtml(state.currentD) + '</div>' : '') +
        '</div>';
    }

    var questionNum = state.totalQuestions > 0
      ? '<div style="font-size:10px;color:var(--text3);margin-top:8px">Question ' + state.questionNum + ' of ' + state.totalQuestions + '</div>'
      : '';

    container.innerHTML =
      '<div style="padding:8px 0">' +
        catTag +
        typeTag +
        '<div style="font-size:16px;font-weight:600;color:var(--text);line-height:1.5;margin:8px 0;padding:0 4px">' +
          questionText +
        '</div>' +
        answerHtml +
        questionNum +
      '</div>';
  }

  function renderAkinator() {
    var inner = '';
    if (state.akinatorGuess) {
      var confText = state.akinatorConfused
        ? 'Hmm, I got confused. My best guess:'
        : (state.akinatorConfident ? 'I am confident! Is it...' : 'My best guess:');
      inner =
        '<div style="font-size:13px;color:var(--text3);margin-bottom:6px">🤖 Akinator</div>' +
        '<div style="font-size:15px;color:var(--text3);margin-bottom:10px">' + confText + '</div>' +
        '<div style="font-size:22px;font-weight:800;color:var(--text);margin-bottom:4px">' + escHtml(state.akinatorGuess) + '</div>' +
        (state.akinatorHint ? '<div style="font-size:12px;color:var(--text3);margin-bottom:12px">' + escHtml(state.akinatorHint) + '</div>' : '') +
        '<div style="display:flex;gap:10px;justify-content:center;margin-top:10px">' +
          '<button onclick="window._akinatorConfirm(true)" style="flex:1;padding:12px;border:none;border-radius:10px;background:#22c55e;color:#fff;font-size:15px;font-weight:700;cursor:pointer">✅ Yes!</button>' +
          '<button onclick="window._akinatorConfirm(false)" style="flex:1;padding:12px;border:none;border-radius:10px;background:#ef4444;color:#fff;font-size:15px;font-weight:700;cursor:pointer">❌ No</button>' +
        '</div>';
    } else {
      inner =
        '<div style="font-size:13px;color:var(--text3);margin-bottom:6px">🤖 Akinator · Question ' + state.akinatorNum + '</div>' +
        '<div style="font-size:16px;font-weight:600;color:var(--text);line-height:1.5;margin:10px 0;padding:0 4px">' + escHtml(state.akinatorQuestion || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text3);margin-bottom:12px">' + state.akinatorRemaining + ' possible characters left</div>' +
        '<div style="display:flex;gap:10px;justify-content:center">' +
          '<button onclick="window._akinatorAnswer(true)" style="flex:1;padding:14px;border:none;border-radius:10px;background:#22c55e;color:#fff;font-size:16px;font-weight:700;cursor:pointer">✅ Yes</button>' +
          '<button onclick="window._akinatorAnswer(false)" style="flex:1;padding:14px;border:none;border-radius:10px;background:#ef4444;color:#fff;font-size:16px;font-weight:700;cursor:pointer">❌ No</button>' +
        '</div>';
    }
    container.innerHTML = '<div style="padding:8px 0">' + inner + '</div>';
  }

  function renderAkinatorDone() {
    var d = state.akinatorDone;
    container.innerHTML =
      '<div style="padding:20px 8px">' +
        '<div style="font-size:34px;margin-bottom:8px">' + (d.won ? '🎉' : '😅') + '</div>' +
        '<div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px">' +
          (d.won ? 'It was ' + escHtml(d.name) + '!' : escHtml(d.message || 'The Akinator gave up!')) +
        '</div>' +
        '<div style="font-size:12px;color:var(--text3);margin-top:10px">Ask the host to start another round</div>' +
      '</div>';
  }

  // ── Message handler (called from index.html's handleMessage) ──
  window.onModMessage = function(msg) {
    switch (msg.type) {
      case 'bq_state':
        state.active = msg.active === true;
        state.gameEnded = msg.gameEnded === true;
        if (!state.active) {
          state.hasQuestion = false;
          state.showAnswer = false;
          state.answerHidden = false;
          state.currentQ = null;
          state.akinatorActive = false;
          state.akinatorDone = null;
        }
        if (msg.total) state.totalQuestions = msg.total;
        render();
        break;

      case 'bq_question':
        state.hasQuestion = true;
        state.showAnswer = false;
        state.answerHidden = false;
        state.currentQ = msg.q;
        state.currentA = null;
        state.currentD = null;
        state.currentType = msg.qType || msg.type || 'standard';
        state.catName = msg.catName || '';
        state.catIcon = msg.catIcon || '';
        state.questionNum = msg.index || 0;
        state.totalQuestions = msg.total || 0;
        render();
        break;

      case 'bq_answer':
        // Winner-only payload
        state.showAnswer = true;
        state.answerHidden = false;
        state.currentA = msg.a;
        state.currentD = msg.d;
        state.lastCorrect = msg.correct;
        render();
        break;

      case 'bq_answer_hidden':
        // Everyone else: result without the answer content
        state.showAnswer = false;
        state.answerHidden = true;
        state.currentA = null;
        state.currentD = msg.d;
        state.revealTo = msg.revealTo;
        state.lastCorrect = msg.correct;
        render();
        break;

      case 'bq_akinator_state':
        state.akinatorActive = msg.active === true;
        state.akinatorDone = null;
        if (!state.akinatorActive) {
          state.akinatorQuestion = null;
          state.akinatorGuess = null;
        }
        render();
        break;

      case 'bq_akinator_question':
        state.akinatorActive = true;
        state.akinatorQuestion = msg.text;
        state.akinatorRemaining = msg.remaining || 0;
        state.akinatorNum = msg.questionNum || 0;
        state.akinatorGuess = null;
        render();
        break;

      case 'bq_akinator_guess':
        state.akinatorActive = true;
        state.akinatorGuess = msg.name;
        state.akinatorHint = msg.hint || '';
        state.akinatorConfident = msg.confident === true;
        state.akinatorConfused = msg.confused === true;
        render();
        break;

      case 'bq_akinator_done':
        state.akinatorActive = false;
        state.akinatorDone = { won: msg.won === true, name: msg.name, message: msg.message };
        render();
        break;

      case 'bq_pool_reset':
        state.hasQuestion = false;
        state.showAnswer = false;
        state.answerHidden = false;
        state.currentQ = null;
        render();
        break;

      case 'bq_reset':
        state.hasQuestion = false;
        state.showAnswer = false;
        state.answerHidden = false;
        state.currentQ = null;
        render();
        break;

      case 'mod_ui_clear':
        if (msg.modId === 'bible-quiz') {
          state.active = false;
          state.hasQuestion = false;
          state.akinatorActive = false;
          container.style.display = 'none';
        }
        break;
    }
  };

  // Akinator answer buttons (called from inline onclick)
  window._akinatorAnswer = function(yes) {
    try {
      if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'bq_akinator_answer', yes: !!yes }));
      }
    } catch(e) {}
  };
  window._akinatorConfirm = function(correct) {
    try {
      if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'bq_akinator_confirm', correct: !!correct }));
      }
    } catch(e) {}
  };

  // Force initial render (will be hidden until activated)
  render();

  // Request current state from server in case we joined mid-game
  if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({type: 'bq_current'}));
    } catch(e) {}
  }

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
