/**
 * Bible Quiz — admin-ui.js
 *
 * Injects a Bible Quiz control panel into the admin page.
 * Shows current question, answer, category, and controls.
 * Communicates via WebSocket (ws global from admin.html).
 */

(function() {
  'use strict';

  var bqContainer = null;
  var bqState = {
    active: false,
    current: null,
    total: 0,
    used: 0,
    categories: [],
  };

  // ── Find where to inject ──
  function findInsertPoint() {
    // Insert after the Actions card, before Teams card
    var actionsCard = document.querySelector('.card:nth-child(1) h3');
    if (actionsCard) {
      // Fallback: look for the modsCard or the admin container
      var modsCard = document.getElementById('modsCard');
      if (modsCard) {
        return modsCard;
      }
    }
    // Fallback: append to the right column
    var rightCol = document.querySelector('.grid-2 > div:last-child');
    return rightCol ? rightCol : document.body;
  }

  function ensureContainer() {
    if (bqContainer && bqContainer.parentNode) return bqContainer;
    bqContainer = document.createElement('div');
    bqContainer.id = 'bqAdminPanel';
    bqContainer.style.cssText = 'display:none;background:#fff;border-radius:12px;padding:14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.05);animation:fadeIn .3s ease-out';
    
    var insertPoint = findInsertPoint();
    if (insertPoint && insertPoint.parentNode) {
      insertPoint.parentNode.insertBefore(bqContainer, insertPoint);
    } else {
      var rightCol = document.querySelector('.grid-2 > div:last-child');
      if (rightCol) rightCol.appendChild(bqContainer);
    }
    return bqContainer;
  }

  function render() {
    var el = ensureContainer();
    if (!el) return;

    if (!bqState.active) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';

    var qInfo = bqState.current
      ? '<div style="font-size:14px;font-weight:600;color:#1a1a2e;margin-bottom:6px;line-height:1.4">' +
          (bqState.current.catIcon || '📖') + ' ' + escHtml(bqState.current.q || '') +
        '</div>' +
        '<div style="font-size:13px;color:#6b7280;margin-bottom:4px">' +
          '<span style="font-weight:500;color:#6c63ff">Answer:</span> ' + escHtml(bqState.current.a || '') +
        '</div>' +
        '<div style="font-size:11px;color:#9ca3af;margin-bottom:10px">' +
          '📖 ' + escHtml(bqState.current.d || '') +
        '</div>'
      : '<div style="padding:20px 0;text-align:center;color:#9ca3af;font-size:14px">' +
          'No question loaded. Start a round to pick one.' +
        '</div>';

    var progress = bqState.total > 0
      ? '<div style="margin-bottom:10px">' +
          '<div style="font-size:11px;color:#6b7280;margin-bottom:4px;display:flex;justify-content:space-between">' +
            '<span>Used: <strong>' + bqState.used + '</strong></span>' +
            '<span>Total: <strong>' + bqState.total + '</strong></span>' +
          '</div>' +
          '<div style="height:4px;background:#e5e7eb;border-radius:2px;overflow:hidden">' +
            '<div style="height:100%;background:#6c63ff;border-radius:2px;width:' + Math.min(100, (bqState.used / bqState.total * 100)) + '%;transition:width .3s"></div>' +
          '</div>' +
        '</div>'
      : '';

    // Category quick-pick buttons
    var catButtons = '';
    if (bqState.categories && bqState.categories.length > 0) {
      catButtons = '<div style="margin-bottom:10px">' +
        '<div style="font-size:11px;color:#6b7280;font-weight:600;margin-bottom:6px">Pick from category:</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px">' +
        bqState.categories.map(function(c) {
          return '<button class="btn btn-sm btn-outline" onclick="window._bqPickCategory(' + c.idx + ')" style="font-size:11px;padding:3px 8px">' + c.icon + ' ' + c.name + ' (' + c.count + ')</button>';
        }).join('') +
        '</div></div>';
    }

    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e5e7eb">' +
        '<span style="font-size:16px">📖</span>' +
        '<span style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;flex:1">Bible Quiz</span>' +
        '<span style="font-size:11px;background:#eef2ff;color:#6c63ff;padding:2px 8px;border-radius:999px;font-weight:600">ACTIVE</span>' +
      '</div>' +
      qInfo +
      progress +
      catButtons +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="btn btn-sm btn-primary" onclick="window._bqNext()">⏭️ Next Question</button>' +
        '<button class="btn btn-sm btn-outline" onclick="window._bqResend()">🔄 Resend</button>' +
        '<button class="btn btn-sm btn-outline" onclick="window._bqReset()">🔁 Reset Pool</button>' +
      '</div>';
  }

  // ── WS message routing ──
  function handleMessage(msg) {
    switch (msg.type) {
      case 'bq_init':
        bqState.active = true;
        bqState.total = msg.total || 0;
        bqState.categories = msg.categories || [];
        bqState.current = null;
        bqState.used = 0;
        render();
        break;

      case 'bq_status':
        bqState.active = true;
        bqState.current = msg.current;
        bqState.total = msg.total || 0;
        bqState.used = msg.used || 0;
        if (msg.categories) bqState.categories = msg.categories;
        render();
        break;

      case 'bq_error':
        showAdminBanner('⚠️ ' + msg.message, '#fee2e2', '#dc2626');
        break;

      case 'bq_reset':
        bqState.current = null;
        bqState.used = 0;
        render();
        break;

      case 'mods_update':
        // Check if our mod got deactivated
        if (msg.mods && msg.activeMod !== 'bible-quiz') {
          bqState.active = false;
          if (bqContainer) bqContainer.style.display = 'none';
        }
        if (msg.activeMod === 'bible-quiz') {
          bqState.active = true;
          render();
        }
        break;
    }
  }

  // ── Expose buttons globally ──
  window._bqNext = function() {
    try { ws.send(JSON.stringify({type: 'bq_next'})); } catch(e) {}
  };
  window._bqResend = function() {
    try { ws.send(JSON.stringify({type: 'bq_current'})); } catch(e) {}
  };
  window._bqReset = function() {
    try { ws.send(JSON.stringify({type: 'bq_reset'})); } catch(e) {}
  };
  window._bqPickCategory = function(idx) {
    try { ws.send(JSON.stringify({type: 'bq_pick_category', catIdx: idx})); } catch(e) {}
  };

  // ── Hook into admin.html's handleMessage ──
  // We intercept by wrapping the existing handleMessage
  var origHandle = window.__bqOrigHandle || window.handleMessage;
  if (typeof origHandle === 'function') {
    window.__bqOrigHandle = origHandle;
    window.handleMessage = function(msg) {
      origHandle(msg);
      handleMessage(msg);
    };
  } else {
    // Poll for handleMessage to be defined
    var check = setInterval(function() {
      if (typeof window.handleMessage === 'function') {
        clearInterval(check);
        window.__bqOrigHandle = window.handleMessage;
        var oldHandle = window.handleMessage;
        window.handleMessage = function(msg) {
          oldHandle(msg);
          handleMessage(msg);
        };
      }
    }, 200);
  }

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  console.log('[BQ-ADMIN] Admin UI loaded');
})();
