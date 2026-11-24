import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const baseDate = '2026-11-24T12:00:00Z';
const accounts = [
  { name: 'utama', password: 'fixture-only-one-password' },
  { name: 'cadangan', password: 'fixture-only-two-password' },
];
const groupKey = 'test-only-club-link-token'.padEnd(32, 'a');

async function fixture(t, settings = {}) {
  let now = baseDate;
  const { app, db } = createApp({
    database: ':memory:', groupKey, publicUrl: 'http://localhost:3000',
    accounts, clock: () => new Date(now), ...settings,
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  async function request(path, body, cookie, headers) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      value: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  async function login(index = 0) {
    const response = await request('/api/host/login', { username: accounts[index].name, password: accounts[index].password });
    assert.equal(response.status, 200);
    return response.cookie;
  }
  const members = () => request('/api/club/' + groupKey);
  return { request, login, members, origin: 'http://127.0.0.1:' + server.address().port, setTime: value => { now = value; } };
}

test('tautan anggota hanya bisa baca, tanpa akses host atau rating internal', async t => {
  const { request, login, members } = await fixture(t);
  assert.equal((await request('/api/club/palsu')).status, 404);
  assert.equal((await request('/api/host', { action: 'addPlayer', name: 'Rahasia' })).status, 401);
  const cookie = await login();
  const result = await request('/api/host', { action: 'addPlayer', name: 'Dimas Saputra' }, cookie);
  assert.equal(result.status, 200);
  assert.equal(result.value.players[0].tier, 'F');
  assert.equal(result.value.players[0].calibration, 0);
  assert.equal((await request('/api/host', undefined, await login(1))).value.players[0].name, 'Dimas Saputra');
  const directory = await members();
  assert.equal(directory.value.players[0].name, 'Dimas Saputra');
  assert.doesNotMatch(JSON.stringify([result.value, directory.value]), /"(?:rating|password|token|code|delta)"\s*:/i);
  assert.equal((await request('/api/host', { action: 'addPlayer', name: 'Nama lain' }, cookie, { Origin: 'https://other.example' })).status, 403);
});



async function sessionWithPlayers(f, count = 4, date) {
  const cookie = await f.login();
  const act = data => f.request('/api/host', data, cookie);
  const write = async data => {
    const result = await act(data);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };
  let view;
  const names = ['Dimas Saputra', 'Galih Pratama', 'Bima Wirawan', 'Heru Aji', 'Agus Andika', 'Doni Adi', 'Indra Wijaya', 'Irfan Saputra'];
  for (const name of names.slice(0, count)) view = await write({ action: 'addPlayer', name, nickname: name.split(' ')[0] });
  const players = names.slice(0, count).map(name => view.players.find(player => player.name === name).id);
  view = await write({ action: 'openSession', courts: 2, date });
  const sessionId = view.sessions[0].id;
  for (const playerId of players) await write({ action: 'attendance', sessionId, playerId, status: 'ready' });
  const teams = [players.slice(0, 2), players.slice(2, 4)];
  async function create(court = 1, matchTeams = teams) {
    const result = await write({ action: 'createMatch', sessionId, court, teams: matchTeams });
    return result.sessions[0].matches.at(-1).id;
  }
  const operate = (action, matchId) => write({ action, sessionId, matchId });
  const start = matchId => operate('startMatch', matchId);
  const finish = matchId => operate('finishMatch', matchId);
  const score = (matchId, score, revision = 0, reportId) => write({ action: 'score', sessionId, matchId, revision, score, reportId });
  const qr = matchId => f.request('/api/host/qr/' + matchId, undefined, cookie);
  const reportPath = async matchId => '/api/report/' + (await qr(matchId)).value.url.split('/').at(-1);
  return { cookie, act, write, players, sessionId, teams, create, start, finish, score, qr, reportPath, origin: f.origin };
}

test('host mengelola nomor lapangan per sesi tanpa mengubah riwayat laga', async t => {
  const f = await fixture(t), s = await sessionWithPlayers(f);
  const change = (action, court) => ({ action, court, sessionId:s.sessionId });
  assert.equal((await f.request('/api/host', change('activateCourt',5))).status,401);
  await s.write(change('activateCourt',5));
  assert.deepEqual((await f.members()).value.sessions[0].activeCourts,[1,2,5]);
  assert.equal((await s.act(change('activateCourt',5))).status,409);
  assert.equal((await s.act(change('activateCourt',21))).status,400);
  const m = await s.create(5);
  assert.equal((await s.act(change('deactivateCourt',5))).status,409);
  await s.start(m);
  assert.equal((await s.act(change('deactivateCourt',5))).status,409);
  await s.finish(m); await s.score(m,[21,18]);
  await s.write(change('deactivateCourt',5));
  assert.equal((await s.act({...change('createMatch',5),teams:s.teams})).status,400);
  const view=(await f.members()).value.sessions[0];
  assert.deepEqual(view.activeCourts,[1,2]); assert.equal(view.courts,2);
  assert.equal(view.matches[0].court,5); assert.deepEqual(view.matches[0].score,[21,18]);
  await s.write(change('activateCourt',5));
  await s.write({action:'closeSession',sessionId:s.sessionId});
  assert.equal((await s.act(change('deactivateCourt',5))).status,409);
});

test('host dapat menghapus hanya skor pilihan dari riwayat anggota dan statistik', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f);
  const finish = async points => {
    const id = await s.create(); await s.start(id); await s.finish(id); await s.score(id, points); return id;
  };
  const keep = await finish([21, 18]), remove = await finish([18, 21]);
  const payload = { action: 'deleteScore', sessionId: s.sessionId, matchId: remove, revision: 1 };
  assert.equal((await f.request('/api/host', payload)).status, 401);
  assert.equal((await s.act({ ...payload, revision: 0 })).status, 409);
  const v = await s.write(payload);
  const deleted = v.sessions[0].matches.find(m => m.id === remove);
  assert.equal(deleted.score, null); assert.equal(deleted.reportOpen, false);
  assert.equal(deleted.scoreDeleted, true);
  assert.equal((await s.act(payload)).status, 409);
  await s.write({ action: 'closeSession', sessionId: s.sessionId });
  const members = (await f.members()).value;
  assert.deepEqual(members.sessions[0].matches.map(m => [m.id, m.score]), [[keep, [21, 18]]]);
  assert.ok(members.players.every(p => p.games === 1));
  assert.equal(members.players.find(p => p.id === s.players[0]).wins, 1);
  await s.write({ ...payload, matchId: keep });
  assert.deepEqual((await f.members()).value.sessions[0].matches, []);
  await s.score(remove, [21, 19], deleted.revision);
  assert.deepEqual((await f.members()).value.sessions[0].matches.map(m => m.id), [remove]);
});

test('hapus laga hanya menghapus satu laga selesai beserta skor, laporan, dan akses QR', async t => {
  const f = await fixture(t), s = await sessionWithPlayers(f);
  const keep = await s.create(); await s.start(keep); await s.finish(keep); await s.score(keep, [21, 18]);
  const remove = await s.create();
  const payload = { action: 'deleteMatch', sessionId: s.sessionId, matchId: remove, revision: 0 };
  assert.equal((await f.request('/api/host', payload)).status, 401);
  assert.equal((await s.act(payload)).status, 409);
  await s.start(remove); assert.equal((await s.act(payload)).status, 409);
  await s.finish(remove);
  const report = await s.reportPath(remove);
  assert.equal((await f.request(report, { playerId: s.players[0], score: [18, 21] })).status, 201);
  await s.score(remove, [18, 21]);
  assert.equal((await s.act(payload)).status, 409);
  await s.write({ action: 'closeSession', sessionId: s.sessionId });
  const view = await s.write({ ...payload, revision: 1 });
  assert.deepEqual(view.sessions[0].matches.map(m => m.id), [keep]);
  const members = (await f.members()).value;
  assert.deepEqual(members.sessions[0].matches.map(m => [m.id, m.score]), [[keep, [21, 18]]]);
  assert.ok(members.players.every(p => p.games === 1));
  assert.equal((await f.request(report)).status, 404);
  assert.equal((await s.act({ ...payload, revision: 1 })).status, 409);
  const hidden = await s.write({ ...payload, action: 'deleteScore', matchId: keep, revision: 1 });
  const empty = await s.write({ ...payload, matchId: keep, revision: hidden.sessions[0].matches[0].revision });
  assert.deepEqual(empty.sessions[0].matches, []);
});

test('host hanya bisa mengganti kredensial sendiri dan perubahan bertahan setelah restart', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'oldpren-auth-'));
  const database = join(folder, 'test.sqlite');
  t.after(() => rmSync(folder, { recursive: true }));
  const path = '/api/host/credentials';
  const firstPassword = accounts[0].password;
  const newPassword = 'fixture-new-password-456';

  await t.test('verifikasi password lama, validasi perubahan, dan cabut sesi akun yang diubah', async t => {
    const { request, login, members } = await fixture(t, { database });
    const primary = await login();
    const secondSession = await login();
    const backup = await login(1);
    const rename = { username: 'host.baru', currentPassword: firstPassword };
    assert.equal((await request(path, rename)).status, 401);
    assert.equal((await request(path, rename, primary, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await request(path, { ...rename, currentPassword: 'wrong' }, primary)).status, 403);
    assert.equal((await request(path, { ...rename, username: accounts[1].name }, primary)).status, 409);
    assert.equal((await request(path, { ...rename, password: 'pendek' }, primary)).status, 400);
    assert.equal((await request(path, { ...rename, password: accounts[1].password }, primary)).status, 400);

    const renamed = await request(path, { ...rename, accountId: 2 }, primary);
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.value, { ok: true });
    assert.equal((await request('/api/host', undefined, primary)).status, 401);
    assert.equal((await request('/api/host', undefined, secondSession)).status, 401);
    assert.equal((await request('/api/host', undefined, backup)).value.host, accounts[1].name);
    assert.equal((await request('/api/host/login', { username: accounts[0].name, password: firstPassword })).status, 401);
    const active = await request('/api/host/login', { username: rename.username, password: firstPassword });
    assert.equal(active.status, 200);
    assert.equal((await request(path, { currentPassword: firstPassword, password: newPassword }, active.cookie)).status, 200);
    assert.equal((await request('/api/host/login', { username: rename.username, password: firstPassword })).status, 401);
    assert.doesNotMatch(JSON.stringify((await members()).value), /host\.baru|password|salt/i);
  });

  await t.test('database tetap memakai kredensial baru sesudah aplikasi dimulai ulang', async t => {
    const { request, login } = await fixture(t, { database });
    assert.equal((await request('/api/host/login', { username: accounts[0].name, password: firstPassword })).status, 401);
    const signedIn = await request('/api/host/login', { username: 'host.baru', password: newPassword });
    assert.equal(signedIn.status, 200);
    assert.equal((await request('/api/host', undefined, signedIn.cookie)).value.host, 'host.baru');
    await login(1);
  });
});

test('password awal pendek dan sama hanya berlaku untuk database lokal', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'oldpren-local-auth-'));
  const database = join(folder, 'test.sqlite');
  t.after(() => rmSync(folder, { recursive: true }));
  const localAccounts = [{ name: 'hostutama', password: 'test-1' }, { name: 'hostkedua', password: 'test-1' }];
  await t.test('kedua akun bisa login di PC dan harus mengganti password sebelum database dipindah', async t => {
    const local = await fixture(t, { database, accounts: localAccounts, allowLocalBootstrap: true });
    const publicSettings = { database, groupKey, publicUrl: 'https://badminton.example.com', accounts, allowLocalBootstrap: true };
    assert.throws(() => createApp(publicSettings), /Ganti password awal kedua akun host/);
    for (const [index, account] of localAccounts.entries()) {
      const login = await local.request('/api/host/login', { username: account.name, password: account.password });
      assert.equal(login.status, 200);
      const changed = await local.request('/api/host/credentials', { currentPassword: account.password, password: 'fixture-password-safe-' + index }, login.cookie);
      assert.equal(changed.status, 200);
    }
    createApp(publicSettings).db.close();
  });
});

test('anggota mendaftar sendiri sekali per tanggal WIB, host mengonfirmasi hadir secara terpisah', async t => {
  const f = await fixture(t);
  f.setTime('2026-11-23T11:00:00Z');
  const s = await sessionWithPlayers(f);
  const directory = (await f.members()).value;
  assert.equal(directory.signup.date, '2026-11-24');
  assert.equal(directory.players.find(player => player.id === s.players[0]).display, 'Dimas Saputra (Dimas)');
  const path = '/api/club/' + groupKey + '/signup';
  const register = { playerId: s.players[0], date: directory.signup.date };
  assert.equal((await f.request(path, { ...register, date: '2026-12-01' })).status, 409);
  assert.equal((await f.request(path, { ...register, playerId: 'invalid' })).status, 400);
  await s.write({ action: 'attendance', sessionId: s.sessionId, playerId: s.players[0], status: 'absent' });
  const result = await Promise.all([f.request(path, register), f.request(path, register)]);
  assert.ok(result.every(response => response.status === 200));
  const host = (await f.request('/api/host', undefined, s.cookie)).value;
  assert.deepEqual(host.signup.playerIds, [s.players[0]]);
  assert.equal(host.sessions[0].attendance[s.players[0]], undefined);
  assert.equal((await f.members()).value.sessions[0].attendance, undefined);
  await s.write({ action: 'attendance', sessionId: s.sessionId, playerId: s.players[0], status: 'ready' });
  f.setTime('2026-11-23T16:59:59Z');
  assert.equal((await f.members()).value.signup.date, '2026-11-24');
  f.setTime('2026-11-23T17:00:00Z');
  const beforeStart = (await f.request('/api/host', undefined, s.cookie)).value;
  assert.equal(beforeStart.signup.date, '2026-11-24');
  assert.equal(beforeStart.sessionDate, '2026-11-24');
  assert.equal((await f.request(path, { ...register, playerId: s.players[1], date: '2026-12-01' })).status, 409);
  const todaySignup = await f.request(path, { ...register, playerId: s.players[1] });
  assert.equal(todaySignup.status, 200);
  assert.deepEqual(todaySignup.value.signup.playerIds, s.players.slice(0, 2));
  f.setTime(baseDate);
  const match = await s.create();
  await s.start(match);
  const started = (await f.request('/api/host', undefined, s.cookie)).value;
  assert.equal(started.signup.date, '2026-11-24');
  assert.deepEqual(started.sessions[0].registered, s.players.slice(0, 2));
  await s.finish(match);
  assert.equal((await f.members()).value.signup.date, '2026-11-24');
  f.setTime('2026-11-24T17:00:00Z'); // Midnight WIB after Tuesday; the session is still open.
  assert.equal((await f.members()).value.signup.date, '2026-11-24');
  const closed = await s.write({ action: 'closeSession', sessionId: s.sessionId });
  assert.equal(closed.signup.date, '2026-12-01');
  assert.deepEqual(closed.sessions[0].registered, s.players.slice(0, 2));
  assert.equal((await f.request(path, register)).status, 409);
  const nextSignup = await f.request(path, { ...register, playerId: s.players[1], date: '2026-12-01' });
  assert.equal(nextSignup.status, 200);
  assert.deepEqual(nextSignup.value.signup.playerIds, [s.players[1]]);
});

test('QR hanya tersedia setelah laga selesai, laporan bersaing menunggu keputusan host', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f);
  const matchId = await s.create();
  assert.equal((await s.qr(matchId)).status, 409);
  await s.start(matchId);
  assert.equal((await s.qr(matchId)).status, 409);
  await s.finish(matchId);
  const reportPath = await s.reportPath(matchId);
  const qrImage = await fetch(s.origin + '/api/host/qr/' + matchId + '/image', { headers: { Cookie: s.cookie } });
  assert.equal(qrImage.status, 200);
  assert.equal(qrImage.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await qrImage.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await f.request(reportPath, { playerId: 'someone-else', score: [21, 10] })).status, 400);
  for (const score of [[21, 20], [22, 19], [30, 27], [29, 28], ['21', 0]]) {
    assert.equal((await f.request(reportPath, { playerId: s.players[0], score })).status, 400);
  }
  assert.equal((await f.request(reportPath, { playerId: s.players[0], score: [30, 29] })).status, 201);
  assert.equal((await f.request(reportPath, { playerId: s.players[1], score: [21, 9] })).status, 201);
  assert.equal((await f.request(reportPath, { playerId: s.players[1], score: [21, 9] })).status, 201);
  const host = (await f.request('/api/host', undefined, s.cookie)).value;
  const [wrong, right] = host.sessions[0].matches[0].reports;
  assert.equal(host.sessions[0].matches[0].reports.length, 2);
  assert.equal(wrong.status, 'pending');
  let memberView = (await f.members()).value;
  assert.equal(memberView.sessions[0].matches[0].reports, undefined);
  assert.equal(memberView.sessions[0].matches[0].score, null);
  assert.ok(memberView.players.every(player => player.tier === 'F' && player.games === 0));
  await s.write({ action: 'rejectReport', sessionId: s.sessionId, matchId, reportId: wrong.id, revision: 0 });
  assert.equal((await s.act({ action: 'score', sessionId: s.sessionId, matchId, revision: 0, score: [21, 9], reportId: right.id })).status, 409);
  await s.score(matchId, [21, 9], 1, right.id);
  assert.equal((await f.request(reportPath, { playerId: s.players[0], score: [21, 8] })).status, 409);
  memberView = (await f.members()).value;
  assert.deepEqual(memberView.sessions[0].matches[0].score, [21, 9]);
  assert.equal(memberView.players.find(player => player.id === s.players[0]).tier, 'F');
  assert.equal(memberView.players.find(player => player.id === s.players[0]).calibration, 1);
  assert.doesNotMatch(JSON.stringify(memberView), /"(?:rating|code|audit|reports|delta)"\s*:/);
});

test('host memilih Selasa yang ditampilkan ke anggota dan bisa menjadwal ulang sebelum laga pertama', async t => {
  const f = await fixture(t);
  f.setTime('2026-11-20T08:00:00Z');
  const cookie = await f.login();
  assert.equal((await f.request('/api/host', { action: 'openSession', date: '2026-11-17' }, cookie)).status, 400);
  assert.equal((await f.request('/api/host', { action: 'openSession', date: '2026-11-25' }, cookie)).status, 400);
  assert.equal((await f.request('/api/host', { action: 'openSession', date: '2027-02-30' }, cookie)).status, 400);
  const s = await sessionWithPlayers(f, 4, '2026-12-01');
  const signupPath = '/api/club/' + groupKey + '/signup';
  const signup = { date: '2026-12-01', playerId: s.players[0] };
  assert.equal((await f.members()).value.signup.date, signup.date);
  assert.equal((await f.request(signupPath, signup)).status, 200);
  const matchId = await s.create();

  const move = { action: 'rescheduleSession', sessionId: s.sessionId, date: '2026-12-08' };
  const rescheduled = await s.write(move);
  assert.equal(rescheduled.sessions[0].date, move.date);
  assert.equal(rescheduled.sessions[0].matches[0].id, matchId);
  assert.deepEqual((await f.members()).value.signup.playerIds, []);
  assert.equal((await f.request(signupPath, signup)).status, 409);
  await s.write({ ...move, date: signup.date });
  assert.deepEqual((await f.members()).value.signup.playerIds, [s.players[0]]);

  const started = await s.start(matchId);
  assert.equal(started.sessions[0].matches[0].status, 'active');
  assert.equal((await s.act(move)).status, 409);
  f.setTime('2026-12-01T11:00:00Z');
  assert.equal((await f.members()).value.signup.date, '2026-12-01');
  await s.finish(matchId);
  await s.write({ action: 'closeSession', sessionId: s.sessionId });
  assert.equal((await f.members()).value.signup.date, '2026-12-08');
});

test('host memilih tier awal, hanya pemain otomatis mendapat bonus kalibrasi', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f);
  assert.equal((await s.act({ action: 'addPlayer', name: 'Tier Salah', initialTier: 'Z' })).status, 400);
  const added = await s.write({ action: 'addPlayer', name: 'Pemain Senior', initialTier: 'A' });
  const senior = added.players.find(player => player.name === 'Pemain Senior');
  assert.equal(senior.tier, 'A');
  assert.equal(senior.calibration, null);
  assert.equal(senior.games, 0);

  const manualId = s.players[0];
  const autoId = s.players[1];
  const edit = { action: 'editPlayer', playerId: manualId, name: 'Dimas Saputra', nickname: 'Dimas' };
  await s.write({ ...edit, initialTier: 'F' });

  const match = await s.create();
  await s.start(match);
  await s.finish(match);
  await s.score(match, [21, 9]);
  const directory = (await f.members()).value;
  const manual = directory.players.find(player => player.id === manualId);
  const auto = directory.players.find(player => player.id === autoId);
  assert.equal(manual.tier, 'F');
  assert.equal(manual.calibration, null);
  assert.equal(manual.wins, 1);
  assert.equal(auto.tier, 'F');
  assert.equal(auto.calibration, 1);
  assert.equal(auto.wins, 1);
  assert.deepEqual(directory.monthlyMvp[0], { month: '2026-11', winners: [auto.display] });
  assert.doesNotMatch(JSON.stringify(directory), /"(?:rating|initialTier|canEditInitialTier)"\s*:/);
  assert.equal((await s.act({ ...edit, initialTier: 'S' })).status, 409);
  assert.equal((await s.act({ ...edit, initialTier: null })).status, 409);
  const renamed = await s.write({ ...edit, nickname: 'Dim' });
  assert.equal(renamed.players.find(player => player.id === manualId).display, 'Dimas Saputra (Dim)');
});

test('saran lapangan minimum dua dan naik pada peserta ke-21 dan ke-28', async t => {
  const f = await fixture(t);
  f.setTime('2026-11-23T12:00:00Z');
  const cookie = await f.login();
  const hostPath = '/api/host';
  const signupPath = '/api/club/' + groupKey + '/signup';
  assert.equal((await f.members()).value.signup.courts, 2);

  const milestones = { 14: 2, 20: 2, 21: 3, 27: 3, 28: 4 };
  for (let count = 1; count <= 28; count++) {
    const name = 'Pemain ' + count;
    const added = await f.request(hostPath, { action: 'addPlayer', name }, cookie);
    assert.equal(added.status, 200);
    const playerId = added.value.players.find(player => player.name === name).id;
    const result = await f.request(signupPath, { date: '2026-11-24', playerId });
    assert.equal(result.status, 200);
    if (milestones[count]) assert.equal(result.value.signup.courts, milestones[count]);
  }

  f.setTime(baseDate);
  const current = (await f.request(hostPath, undefined, cookie)).value;
  assert.equal(current.signup.date, '2026-12-01');
  assert.equal(current.signup.courts, 2);
  assert.equal(current.sessionDate, '2026-11-24');
  assert.equal(current.suggestedSessionCourts, 4);
  const opened = await f.request(hostPath, { action: 'openSession' }, cookie);
  assert.equal(opened.status, 200);
  assert.equal(opened.value.sessions[0].courts, 4);
});

test('QR ditutup tepat tengah malam WIB atau saat sesi ditutup, host tetap bisa isi skor', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f);
  const first = await s.create();
  await s.start(first);
  await s.finish(first);
  const firstReport = await s.reportPath(first);
  const second = await s.create();
  await s.start(second);
  await s.finish(second);
  const secondReport = await s.reportPath(second);
  f.setTime('2026-11-24T16:59:59Z');
  assert.equal((await f.request(firstReport)).value.open, true);
  f.setTime('2026-11-24T17:00:00Z');
  assert.equal((await f.request(firstReport)).value.open, false);
  assert.equal((await f.request(firstReport, { playerId: s.players[0], score: [21, 9] })).status, 409);
  f.setTime('2026-11-24T16:59:59Z');
  await s.write({ action: 'closeSession', sessionId: s.sessionId });
  assert.equal((await f.request(secondReport)).value.open, false);
  assert.equal((await f.members()).value.sessions[0].matches[1].status, 'unscored');
  f.setTime('2026-11-25T02:00:00Z');
  await s.score(second, [22, 20]);
  assert.deepEqual((await f.members()).value.sessions[0].matches[1].score, [22, 20]);
});

test('host mengunci pemain, bisa antrekan laga lain, dan pemain tidak aktif di dua lapangan', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f, 8);
  const suggestion = await f.request('/api/host/suggest', { sessionId: s.sessionId, locked: [s.players[0], null, null, null] }, s.cookie);
  assert.equal(suggestion.status, 200);
  assert.deepEqual(suggestion.value.teams, suggestion.value.alternatives[0]);
  assert.ok(suggestion.value.alternatives.every(teams => teams[0][0] === s.players[0]));
  assert.equal(suggestion.value.teams[0][0], s.players[0]);
  assert.equal(new Set(suggestion.value.teams.flat()).size, 4);
  const first = await s.create();
  await s.start(first);
  assert.equal((await s.act({ action: 'createMatch', court: 2, sessionId: s.sessionId, teams: s.teams })).status, 409);
  const next = await s.create(1, [s.players.slice(4, 6), s.players.slice(6, 8)]);
  assert.equal((await s.act({ action: 'startMatch', sessionId: s.sessionId, matchId: next })).status, 409);
  await s.finish(first);
  await s.start(next);
  const view = (await f.members()).value.sessions[0];
  assert.equal(view.matches[1].status, 'active');
  assert.equal(view.matches[0].score, null);
});

test('koreksi skor dihitung ulang sekali sesuai urutan pertandingan, kalibrasi selesai setelah lima skor resmi', async t => {
  const f = await fixture(t);
  const s = await sessionWithPlayers(f);
  const matches = [];
  for (let game = 0; game < 5; game++) {
    const matchId = await s.create();
    matches.push(matchId);
    await s.start(matchId);
    await s.finish(matchId);
  }
  for (const matchId of matches.slice().reverse()) await s.score(matchId, [21, 12]);
  const member = async () => (await f.members()).value.players.find(player => player.id === s.players[0]);
  assert.equal((await member()).wins, 5);
  assert.equal((await member()).calibration, 5);
  await s.score(matches[0], [8, 21], 1);
  const player = await member();
  assert.equal(player.wins, 4);
  assert.equal(player.losses, 1);
  assert.equal(player.games, 5);
  await s.score(matches[0], [8, 21], 2);
  assert.equal((await member()).games, 5);
  const host = (await f.request('/api/host', undefined, s.cookie)).value;
  assert.equal(host.sessions[0].matches[0].audit.length, 2);
  const ranks = (await f.members()).value.players.filter(item => item.tier === player.tier).map(item => item.rank);
  assert.deepEqual(ranks, Array.from({ length: ranks.length }, (_, index) => index + 1));
});
