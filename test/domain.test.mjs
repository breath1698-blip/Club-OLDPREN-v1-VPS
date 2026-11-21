import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHost, canReport, day, newClub, nextTuesday, RuleError, suggest, validScore } from '../domain.mjs';

const monday = new Date('2026-11-23T16:59:59Z');
const tuesday = new Date('2026-11-23T17:00:00Z');
const wednesday = new Date('2026-11-24T17:00:00Z');
const sessionDate = '2026-11-24';
const isConflict = error => error instanceof RuleError && error.status === 409;

function queuedMatch() {
  const club = newClub();
  const players = ['Ayu', 'Bima', 'Citra', 'Dimas'];
  const match = { id: 'laga-1', court: 1, teams: [players.slice(0, 2), players.slice(2)], status: 'queued', score: null };
  const session = {
    id: 'sesi-1', date: sessionDate, courts: 1, closed: false, matches: [match],
    attendance: Object.fromEntries(players.map(id => [id, { status: 'ready', since: monday.toISOString() }])),
  };
  club.players = players.map(name => ({ id: name, name, archived: false }));
  club.sessions.push(session);
  return { club, session, match };
}

test('skor satu gim menerima hasil yang sah dan menolak skor di luar batas', () => {
  const accepted = [[21, 0], [19, 21], [22, 20], [27, 29], [30, 28], [29, 30]];
  const rejected = [
    null, [21], [21, 19, 0], [21, '19'], [21, -1], [21, 18.5],
    [20, 18], [21, 20], [22, 19], [22, 21], [29, 29], [30, 27], [31, 29],
  ];
  for (const score of accepted) assert.equal(validScore(score), true, JSON.stringify(score));
  for (const score of rejected) assert.equal(validScore(score), false, JSON.stringify(score));
});

test('tanggal berganti tepat tengah malam WIB dan Selasa yang sudah ditutup dilewati', () => {
  const club = newClub();
  assert.equal(day(monday), '2026-11-23');
  assert.equal(day(tuesday), sessionDate);
  assert.equal(nextTuesday(club, monday), sessionDate);
  assert.equal(nextTuesday(club, tuesday), sessionDate);
  assert.equal(nextTuesday(club, tuesday, false), '2026-12-01');
  club.sessions.push({ date: sessionDate, closed: true }, { date: '2026-12-01', closed: true });
  assert.equal(nextTuesday(club, tuesday), '2026-12-08');
});

test('laga bisa dimulai sebelum atau sesudah tanggal sesi yang masih terbuka', () => {
  for (const startTime of [monday, wednesday]) {
    const { club, session, match } = queuedMatch();
    applyHost(club, { action: 'startMatch', sessionId: session.id, matchId: match.id }, startTime, 'host');
    assert.equal(match.status, 'active');
    assert.equal(match.startedAt, startTime.toISOString());
  }
});

test('laga yang pemainnya belum siap atau sesinya sudah tutup tidak bisa dimulai', () => {
  const { club, session, match } = queuedMatch();
  const action = { action: 'startMatch', sessionId: session.id, matchId: match.id };
  session.attendance.Ayu.status = 'rest';
  assert.throws(() => applyHost(club, action, monday, 'host'), isConflict);
  assert.equal(match.status, 'queued');
  assert.equal(match.startedAt, undefined);

  session.attendance.Ayu.status = 'ready';
  session.closed = true;
  assert.throws(() => applyHost(club, action, monday, 'host'), isConflict);
  assert.equal(match.status, 'queued');
  assert.equal(match.startedAt, undefined);
});

test('host bisa membatalkan laga yang masih antre, sedangkan laga berskor resmi terkunci', () => {
  const { club, session, match } = queuedMatch();
  const action = { action: 'cancelMatch', sessionId: session.id, matchId: match.id };
  applyHost(club, action, monday, 'host');
  assert.equal(match.status, 'cancelled');

  const scored = { ...match, id: 'laga-resmi', status: 'finished', score: [21, 15] };
  session.matches.push(scored);
  assert.throws(() => applyHost(club, { ...action, matchId: scored.id }, tuesday, 'host'), isConflict);
  assert.equal(scored.status, 'finished');
  assert.deepEqual(scored.score, [21, 15]);
});

test('QR hanya menerima laporan pada tanggal sesi untuk laga selesai tanpa skor resmi', () => {
  const { session, match } = queuedMatch();
  assert.equal(canReport(session, match, tuesday), false);
  match.status = 'finished';
  assert.equal(canReport(session, match, monday), false);
  assert.equal(canReport(session, match, tuesday), true);
  assert.equal(canReport(session, match, wednesday), false);
  assert.equal(canReport({ ...session, closed: true }, match, tuesday), false);
  assert.equal(canReport(session, { ...match, score: [21, 15] }, tuesday), false);
});

test('saran tim memberi pasangan baru untuk pemain dengan tier dan waktu tunggu yang sama', () => {
  const { club, session, match } = queuedMatch();
  match.status = 'finished';
  const teams = suggest(club, session, [null, null, null, null]);
  assert.deepEqual(teams.map(team => team.length), [2, 2]);
  assert.deepEqual(new Set(teams.flat()), new Set(match.teams.flat()));
  for (const priorTeam of match.teams) {
    assert.ok(teams.every(team => !priorTeam.every(playerId => team.includes(playerId))));
  }
});
