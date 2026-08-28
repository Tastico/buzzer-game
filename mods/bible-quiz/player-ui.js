/**
 * Bible Quiz — player-ui.js
 *
 * Injected into the mod-area when Bible Quiz mod is active.
 * Shows the current question, supports fill-in-the-blank visual.
 * Communicates via window.onModMessage(msg).
 */

(function() {
  'use strict';

  var container = document.getElementById('mod-area');
  if (!container) return;

  var state = {
    hasQuestion: false,
    showAnswer: false,
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
  };

  // ── Render ──
  function render() {
    if (!state.active || state.gameEnded) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    container.style.padding = '16px';
    container.style.textAlign = 'center';

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
    }

    var questionNum = state.totalQuestions > 0
      ? '<div style="font-size:10px;color:var(--text3);margin-top:8px">Question ' + state.questionNum + ' of ' + state.totalQuestions + '</div>'
      : '';

    container.innerHTML =
      '<div style="padding:8px 0">' +
        catTag +
        '<div style="font-size:16px;font-weight:600;color:var(--text);line-height:1.5;margin:8px 0;padding:0 4px">' +
          questionText +
        '</div>' +
        answerHtml +
        questionNum +
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
          state.currentQ = null;
        }
        if (msg.total) state.totalQuestions = msg.total;
        render();
        break;

      case 'bq_question':
        state.hasQuestion = true;
        state.showAnswer = false;
        state.currentQ = msg.q;
        state.currentA = null;
        state.currentD = null;
        state.currentType = msg.type || 'standard';
        state.catName = msg.catName || '';
        state.catIcon = msg.catIcon || '';
        state.questionNum = msg.index || 0;
        state.totalQuestions = msg.total || 0;
        render();
        break;

      case 'bq_answer':
        state.showAnswer = true;
        state.currentA = msg.a;
        state.currentD = msg.d;
        state.lastCorrect = msg.correct;
        render();
        break;

      case 'bq_pool_reset':
        state.hasQuestion = false;
        state.showAnswer = false;
        state.currentQ = null;
        render();
        break;

      case 'bq_reset':
        state.hasQuestion = false;
        state.showAnswer = false;
        state.currentQ = null;
        render();
        break;

      case 'mod_ui_clear':
        if (msg.modId === 'bible-quiz') {
          state.active = false;
          state.hasQuestion = false;
          container.style.display = 'none';
        }
        break;
    }
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
