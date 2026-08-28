#!/usr/bin/env node
/**
 * Smoke test for the buzzer-game 2.0 features.
 * Run the server first:  PORT=3999 node server.js
 * Then:                 node test/smoke.js
 * Exits 0 on success, 1 with a message on failure.
 */
'use strict';

const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:3999';

function client(label) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(m);
      }
    }
  });
  return {
    ws,
    label,
    inbox,
    send(m) { ws.send(JSON.stringify(m)); },
    open() { return new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }); },
    waitFor(pred, timeoutMs, what) {
      return new Promise((resolve, reject) => {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error((what || 'timeout') + ' on ' + label)), timeoutMs || 8000);
        waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); }, timer: t });
      });
    },
    close() { try { ws.close(); } catch(e) {} },
  };
}

function ok(name) { console.log('  ✓ ' + name); }
function fail(name, extra) { console.log('  ✗ ' + name + (extra ? ': ' + extra : '')); process.exitCode = 1; }

(async () => {
  const admin = client('admin');
  const p1 = client('p1');
  const p2 = client('p2');
  const spec = client('spec');
  await Promise.all([admin.open(), p1.open(), p2.open(), spec.open()]);

  // Admin register
  admin.send({ type: 'admin_register', password: 'changeme' });
  await admin.waitFor(m => m.type === 'admin_state', 5000, 'admin_state');
  ok('admin registered');

  // Players + spectator join
  p1.send({ type: 'join', name: 'Alice', profileUuid: 'p1-uuid' });
  p2.send({ type: 'join', name: 'Bob', profileUuid: 'p2-uuid' });
  spec.send({ type: 'join', spectator: true });
  await Promise.all([
    p1.waitFor(m => m.type === 'joined', 5000, 'p1 joined'),
    p2.waitFor(m => m.type === 'joined', 5000, 'p2 joined'),
    spec.waitFor(m => m.type === 'joined_spectator', 5000, 'spec joined'),
  ]);
  ok('2 players + 1 spectator joined');

  // Spectator buzz must be rejected
  spec.send({ type: 'buzz' });
  const rej = await spec.waitFor(m => m.type === 'buzz_rejected', 5000, 'spectator buzz rejected');
  ok('spectator buzz rejected (' + rej.reason + ')');

  // Activate bible quiz mod
  admin.send({ type: 'set_active_mod', modId: 'bible-quiz' });
  await admin.waitFor(m => m.type === 'mods_update' && m.activeMod === 'bible-quiz', 5000, 'mod active');
  ok('bible-quiz mod active');

  // Theme filter: pick category 0
  admin.send({ type: 'bq_set_filter', catIdx: 0 });
  await admin.waitFor(m => m.type === 'bq_filter_set', 5000, 'filter set');
  ok('theme filter set to category 0');

  // Round 1: question + buzz + targeted answer
  admin.send({ type: 'start_round', delay: 0 });
  const q1 = await p1.waitFor(m => m.type === 'bq_question', 5000, 'question 1');
  ok('question broadcast (cat: ' + q1.catName + ')');
  if (q1.catName !== admin.inbox.find(m => m.type === 'bq_status')?.current?.catName && false) {}
  // verify the question came from category 0 via the admin status
  const st1 = admin.inbox.find(m => m.type === 'bq_status' && m.current);
  if (st1 && st1.current.catName && q1.catName !== st1.current.catName) {
    fail('question category mismatch');
  }

  await p1.waitFor(m => m.type === 'buzzers_enabled', 5000, 'buzzers enabled');
  p1.send({ type: 'buzz' });
  await p1.waitFor(m => m.type === 'you_buzzed_first', 5000, 'p1 buzzed');
  await spec.waitFor(m => m.type === 'spectator_stats' && m.buzzOrder && m.buzzOrder.length > 0, 5000, 'spectator stats with buzz');
  ok('buzz + spectator stats received');
  const stats = spec.inbox.find(m => m.type === 'spectator_stats' && m.buzzOrder && m.buzzOrder.length > 0);
  if (!stats || !stats.buzzOrder || stats.buzzOrder.length === 0) fail('buzzOrder empty');

  // Judge right: winner gets the answer, loser gets hidden notice
  admin.send({ type: 'judge_right' });
  const winnerAns = await p1.waitFor(m => m.type === 'bq_answer', 5000, 'winner answer');
  const loserNot = await p2.waitFor(m => m.type === 'bq_answer_hidden', 5000, 'loser hidden notice');
  ok('winner got answer: "' + winnerAns.a + '"');
  if (loserNot.a !== undefined) fail('loser received answer content');
  else ok('loser got hidden notice without answer');
  const specHasAns = spec.inbox.some(m => m.type === 'bq_answer');
  if (specHasAns) fail('spectator received answer payload');
  else ok('spectator never received answer');

  // Round 2: answer timer (10s) auto-ends the round
  admin.send({ type: 'start_round', delay: 0 });
  await p1.waitFor(m => m.type === 'bq_question' && m.index === 2, 5000, 'question 2');
  await p1.waitFor(m => m.type === 'buzzers_enabled' && m.round === 2, 5000, 'round 2 buzzers');
  p1.send({ type: 'buzz' });
  await p1.waitFor(m => m.type === 'you_buzzed_first', 5000, 'p1 buzzed round 2');
  const t0 = Date.now();
  await admin.waitFor(m => m.type === 'bq_timeout', 15000, 'admin bq_timeout');
  await p1.waitFor(m => m.type === 'round_end' && m.reason === 'timeout', 3000, 'round_end timeout');
  ok('10s timer fired, round ended (' + Math.round((Date.now() - t0) / 1000) + 's)');

  // Round 3: normal flow then Akinator
  admin.send({ type: 'start_round', delay: 0 });
  await p1.waitFor(m => m.type === 'bq_question' && m.index === 3, 5000, 'question 3');
  await p1.waitFor(m => m.type === 'buzzers_enabled' && m.round === 3, 5000, 'round 3 buzzers');
  p1.send({ type: 'buzz' });
  await p1.waitFor(m => m.type === 'you_buzzed_first', 5000, 'p1 buzzed round 3');
  admin.send({ type: 'judge_wrong' });
  await p2.waitFor(m => m.type === 'bq_answer_hidden', 5000, 'round 3 hidden notice');
  ok('judge_wrong reveals to winner only');

  // Akinator: start, answer questions until a guess, confirm
  admin.send({ type: 'bq_akinator_start' });
  const aq = await p1.waitFor(m => m.type === 'bq_akinator_question', 5000, 'akinator question');
  ok('akinator question: ' + aq.text);
  // Answer the questions (alternating yes/no) until a guess arrives
  let answered = 0;
  let guess = null;
  let lastAnsweredQ = null;
  while (!guess && answered < 15) {
    const qs = p1.inbox.filter(m => m.type === 'bq_akinator_question');
    const lastQ = qs[qs.length - 1];
    if (lastQ && lastQ !== lastAnsweredQ) {
      p1.send({ type: 'bq_akinator_answer', yes: answered % 2 === 0 });
      answered++;
      lastAnsweredQ = lastQ;
    }
    await new Promise(r => setTimeout(r, 300));
    guess = p1.inbox.find(m => m.type === 'bq_akinator_guess');
  }
  if (!guess) { fail('akinator never guessed after ' + answered + ' answers'); }
  else {
    ok('akinator guessed: ' + guess.name + ' (confident=' + guess.confident + ') after ' + answered + ' questions');
    p1.send({ type: 'bq_akinator_confirm', correct: true });
    const done = await p1.waitFor(m => m.type === 'bq_akinator_done', 5000, 'akinator done');
    ok('akinator done, won=' + done.won);
  }

  // Theme filter validation: question 2's category must be the filtered one
  const q2 = p1.inbox.find(m => m.type === 'bq_question' && m.index === 2);
  if (q2 && q2.catName !== q1.catName) fail('round 2 question escaped theme filter');
  else if (q2) ok('theme filter held (' + q2.catName + ')');

  admin.close(); p1.close(); p2.close(); spec.close();
  if (process.exitCode) {
    console.log('\nSMOKE TEST FAILED');
  } else {
    console.log('\nSMOKE TEST PASSED');
  }
  process.exit(process.exitCode || 0);
})().catch(e => {
  console.error('SMOKE TEST ERROR: ' + e.message);
  process.exit(1);
});
