import { randomUUID, randomBytes } from 'node:crypto';

export const newClub = () => ({ players: [], sessions: [], signups: {}, sequence: 0 });
export const id = randomUUID;
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });
export const day = now => dateFormat.format(now);
const midnight = date => new Date(date + 'T00:00:00Z');
export const isTuesday = date => midnight(date).getUTCDay() === 2;
const moveDay = (date, days) => new Date(midnight(date).getTime() + days * 86400000).toISOString().slice(0, 10);

export function nextTuesday(club, now, includeToday = true) {
  const today = day(now);
  const days = (9 - midnight(today).getUTCDay()) % 7;
  let date = moveDay(today, days || (includeToday ? 0 : 7));
  while (club.sessions.some(session => session.date === date && session.closed)) date = moveDay(date, 7);
  return date;
}

function signupTuesday(club, now) {
  const today = day(now);
  const scheduled = club.sessions.find(session => !session.closed && session.date > today);
  return scheduled?.date ?? nextTuesday(club, now, false);
}

function validateSessionDate(club, date, now, sessionId) {
  requireRule(typeof date === 'string' && date.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && isTuesday(date) && day(midnight(date)) === date && date >= day(now), 'Pilih tanggal Selasa, mulai hari ini atau setelahnya (WIB).');
  requireRule(!club.sessions.some(session => session.id !== sessionId && session.date === date), 'Tanggal ini sudah punya sesi.', 409);
  return date;
}

const maxCourts = 20;

function courtPlan(club, date) {
  const playerIds = (club.signups[date] ?? []).filter(playerId =>
    club.players.some(player => player.id === playerId && !player.archived));
  const courts = Math.min(maxCourts, Math.max(2, Math.floor(playerIds.length / 7)));
  return { date, playerIds, courts };
}

export class RuleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requireRule(ok, message, status) {
  if (!ok) throw new RuleError(message, status);
}

export function validScore(score) {
  if (!Array.isArray(score) || score.length !== 2 || !score.every(value => Number.isInteger(value) && value >= 0 && value <= 30)) return false;
  const high = Math.max(...score);
  const low = Math.min(...score);
  return (high === 21 && low <= 19) || (high > 21 && high < 30 && high - low === 2) || (high === 30 && (low === 28 || low === 29));
}

const tiers = [['SS', 1160], ['S', 1130], ['A', 1100], ['B', 1075], ['C', 1050], ['D', 1030], ['E', 1015], ['F', -Infinity]];
const startingRatings = new Map(tiers.map(([tier, minimum], index) => {
  const ceiling = tiers[index - 1]?.[1] ?? minimum + 30;
  return [tier, tier === 'F' ? 1000 : Math.floor((minimum + ceiling) / 2)];
}));
const tierOf = rating => tiers.find(([, minimum]) => rating >= minimum)[0];
const allMatches = club => club.sessions.flatMap(session => session.matches);
const teamAverage = (team, strength) => team.reduce((total, playerId) => total + strength.get(playerId).rating, 0) / team.length;

export function standings(club) {
  const strength = new Map(club.players.map(player => [player.id, {
    rating: startingRatings.get(player.initialTier ?? 'F'), usesCalibration: !player.initialTier,
    games: 0, wins: 0, losses: 0, history: [],
  }]));
  const matches = allMatches(club).filter(match => match.score).sort((left, right) => left.finishOrder - right.finishOrder);

  for (const match of matches) {
    const winner = Number(match.score[1] > match.score[0]);
    const winnerTeam = match.teams[winner];
    const loserTeam = match.teams[1 - winner];
    const difference = teamAverage(winnerTeam, strength) - teamAverage(loserTeam, strength);
    const expected = 1 / (1 + 10 ** (-difference / 100));
    const margin = Math.abs(match.score[0] - match.score[1]);
    const base = margin <= 4 ? 3 : margin <= 8 ? 5 : 8;
    const change = Math.max(1, Math.round(2 * base * (1 - expected)));

    match.teams.forEach((team, index) => {
      for (const playerId of team) {
        const player = strength.get(playerId);
        const won = index === winner;
        const calibrating = player.usesCalibration && player.games < 5;
        const before = tierOf(player.rating);
        player.rating += won ? change * (calibrating ? 3 : 1) : -(calibrating ? Math.ceil(change / 2) : change);
        player.games++;
        if (won) player.wins++;
        else player.losses++;
        const after = tierOf(player.rating);
        if (before !== after) player.history.push({ date: match.finishedAt, from: before, to: after });
      }
    });
  }
  return strength;
}

const label = player => player.nickname ? player.name + ' (' + player.nickname + ')' : player.name;
const byName = (left, right) => label(left).localeCompare(label(right), 'id');
const activeIds = session => new Set(session.matches.filter(match => match.status === 'active').flatMap(match => match.teams.flat()));
const queuedIds = session => new Set(session.matches.filter(match => match.status === 'queued').flatMap(match => match.teams.flat()));
const playerReady = (club, session, playerId) => session.attendance[playerId]?.status === 'ready' && club.players.some(player => player.id === playerId && !player.archived);

export function suggest(club, session, locked) {
  requireRule(Array.isArray(locked) && locked.length === 4, 'Pilih empat slot pemain.');
  const busy = activeIds(session);
  const queued = queuedIds(session);
  const pins = locked.filter(Boolean);
  const available = club.players.filter(player => playerReady(club, session, player.id) && !busy.has(player.id) && !queued.has(player.id));
  requireRule(new Set(pins).size === pins.length && pins.every(playerId => available.some(player => player.id === playerId)), 'Pemain yang dipilih sedang tidak tersedia.');
  requireRule(available.length >= 4, 'Butuh empat pemain siap main yang belum terjadwal.');
  const strength = standings(club);
  const recent = session.matches.filter(match => ['finished', 'unscored'].includes(match.status)).slice(-8);
  const priority = player => Date.parse(session.attendance[player.id].since);
  const minPriority = Math.min(...available.map(priority));
  // Kelompok tunggu dua menit memberi ruang untuk menyeimbangkan tim yang masuk antrean hampir bersamaan.
  const waitingGroup = player => Math.floor((priority(player) - minPriority) / 120000);
  const unordered = available.filter(player => !pins.includes(player.id))
    .sort((left, right) => waitingGroup(left) - waitingGroup(right) || priority(left) - priority(right) || byName(left, right));
  const needed = 4 - pins.length;
  const seats = locked.map((playerId, index) => playerId ? -1 : index).filter(index => index >= 0);
  const playersToUse = unordered.slice(0, needed);
  const lastGroup = playersToUse.length ? waitingGroup(playersToUse.at(-1)) : 0;
  const fixed = playersToUse.filter(player => waitingGroup(player) < lastGroup);
  const flexible = unordered.filter(player => waitingGroup(player) === lastGroup);
  let best = null;

  function evaluate(candidate) {
    const teams = [candidate.slice(0, 2), candidate.slice(2)];
    const gap = Math.abs(teamAverage(teams[0], strength) - teamAverage(teams[1], strength));
    let repeats = 0;
    for (const match of recent) {
      for (const [own, opposing] of [[teams[0], teams[1]], [teams[1], teams[0]]]) {
        const prior = match.teams.find(team => team.includes(own[0]));
        if (prior?.includes(own[1])) repeats += 2;
        if (prior) {
          const other = match.teams.find(team => team !== prior);
          repeats += opposing.filter(playerId => other.includes(playerId)).length;
        }
      }
    }
    const merit = gap + Math.min(repeats, 8);
    if (!best || merit < best.merit) best = { teams, merit };
  }

  // shortcut: cek 16 kandidat dari kelompok tunggu terakhir, perlu diperluas kalau host butuh semua kombinasi.
  const pool = [...fixed, ...flexible.slice(0, 16)].map(player => player.id);
  const mustUse = new Set(fixed.map(player => player.id));
  function fill(seat, candidate, remaining) {
    if (seat === seats.length) {
      if (![...mustUse].some(playerId => remaining.includes(playerId))) evaluate(candidate);
      return;
    }
    for (const playerId of remaining) {
      candidate[seats[seat]] = playerId;
      fill(seat + 1, candidate, remaining.filter(other => other !== playerId));
    }
  }
  fill(0, locked.slice(), pool);
  return best.teams;
}

function validateName(input, required) {
  requireRule(typeof input === 'string', 'Nama tidak valid.');
  const name = input.trim().replace(/\s+/gu, ' ').normalize('NFC');
  requireRule((!required || name.length >= 2) && name.length <= (required ? 100 : 50) && !/[\p{Cc}\p{Cf}]/u.test(name), 'Periksa panjang dan isi nama pemain.');
  return name;
}

export function applyHost(club, data, now, host) {
  const { action } = data;
  if (action === 'addPlayer' || action === 'editPlayer') {
    const name = validateName(data.name, true);
    const nickname = validateName(data.nickname ?? '', false);
    const initialTier = data.initialTier ?? null;
    requireRule(initialTier === null || startingRatings.has(initialTier), 'Pilihan tier awal tidak valid.');
    const display = label({ name, nickname }).toLocaleLowerCase('id');
    requireRule(!club.players.some(player => player.id !== data.playerId && label(player).toLocaleLowerCase('id') === display), 'Nama tampilan ini sudah ada.', 409);
    if (action === 'addPlayer') {
      requireRule(club.players.length < 1000, 'Roster penuh.');
      club.players.push({ id: id(), name, nickname, initialTier, archived: false });
    } else {
      const player = club.players.find(item => item.id === data.playerId);
      requireRule(player, 'Pemain tidak ditemukan.', 404);
      if (data.initialTier !== undefined && initialTier !== (player.initialTier ?? null)) {
        const hasOfficialScore = allMatches(club).some(match => match.score && match.teams.flat().includes(player.id));
        requireRule(!hasOfficialScore, 'Tier awal terkunci setelah skor resmi pertama.', 409);
        player.initialTier = initialTier;
      }
      Object.assign(player, { name, nickname });
    }
    return;
  }
  if (action === 'archivePlayer') {
    const player = club.players.find(item => item.id === data.playerId);
    requireRule(player, 'Pemain tidak ditemukan.', 404);
    requireRule(typeof data.archived === 'boolean', 'Pilih status pemain.');
    const session = club.sessions.find(item => !item.closed);
    if (data.archived && session) {
      requireRule(!activeIds(session).has(player.id) && !queuedIds(session).has(player.id), 'Selesaikan atau batalkan laga pemain ini dulu.', 409);
      if (session.attendance[player.id]) session.attendance[player.id].status = 'left';
    }
    player.archived = data.archived;
    return;
  }
  if (action === 'removeSignup') {
    requireRule(data.date === signupTuesday(club, now), 'Daftar sesi sudah berganti.', 409);
    club.signups[data.date] = (club.signups[data.date] ?? []).filter(playerId => playerId !== data.playerId);
    return;
  }
  if (action === 'openSession') {
    requireRule(!club.sessions.some(session => !session.closed), 'Tutup sesi sebelumnya dulu.', 409);
    const date = validateSessionDate(club, data.date === undefined ? nextTuesday(club, now) : data.date, now);
    const courts = data.courts === undefined ? courtPlan(club, date).courts : data.courts;
    requireRule(Number.isInteger(courts) && courts >= 1 && courts <= maxCourts, 'Isi jumlah lapangan antara 1 dan ' + maxCourts + '.');
    club.sessions.push({ id: id(), date, courts, closed: false, attendance: {}, matches: [] });
    return;
  }

  const session = club.sessions.find(item => item.id === data.sessionId);
  requireRule(session, 'Sesi tidak ditemukan.', 404);
  if (action === 'score' || action === 'rejectReport') {
    const match = session.matches.find(item => item.id === data.matchId);
    requireRule(match && ['finished', 'unscored'].includes(match.status), 'Hasil hanya bisa dicatat setelah laga selesai.', 409);
    requireRule(match.revision === data.revision, 'Data berubah di perangkat lain. Muat ulang lalu coba lagi.', 409);
    if (action === 'rejectReport') {
      requireRule(!match.score, 'Skor sudah resmi.', 409);
      const report = match.reports.find(item => item.id === data.reportId && item.status === 'pending');
      requireRule(report, 'Usulan sudah diproses.', 409);
      report.status = 'rejected';
    } else {
      requireRule(validScore(data.score), 'Skor belum sesuai aturan satu gim sampai 21, maksimal 30.');
      const report = data.reportId ? match.reports.find(item => item.id === data.reportId && item.status === 'pending') : null;
      requireRule(!data.reportId || (report && report.score.every((value, index) => value === data.score[index])), 'Usulan skor sudah berubah.', 409);
      if (!match.score || match.score.some((points, index) => points !== data.score[index])) {
        match.audit.push({ previous: match.score, score: data.score, at: now.toISOString(), host });
        match.score = data.score;
      }
      match.status = 'finished';
      for (const item of match.reports) {
        if (item.status === 'pending') item.status = item === report ? 'accepted' : 'rejected';
      }
    }
    match.revision++;
    return;
  }

  requireRule(!session.closed, 'Sesi sudah ditutup.', 409);
  if (action === 'rescheduleSession') {
    requireRule(!session.matches.some(match => match.startedAt), 'Tanggal terkunci setelah pertandingan pertama dimulai.', 409);
    session.date = validateSessionDate(club, data.date, now, session.id);
    return;
  }
  if (action === 'closeSession') {
    requireRule(!session.matches.some(match => match.status === 'active'), 'Selesaikan atau batalkan pertandingan aktif dulu.', 409);
    const stamp = now.toISOString();
    session.closed = true;
    session.closedAt = stamp;
    for (const match of session.matches) {
      if (match.status === 'queued') match.status = 'cancelled';
      if (match.status === 'finished' && !match.score) match.status = 'unscored';
    }
    return;
  }
  if (action === 'attendance') {
    const player = club.players.find(item => item.id === data.playerId && !item.archived);
    requireRule(player, 'Pemain aktif tidak ditemukan.', 404);
    requireRule(['ready', 'rest', 'left', 'absent'].includes(data.status), 'Status kehadiran tidak valid.');
    const current = session.attendance[player.id];
    if (current?.status === data.status || (!current && data.status === 'absent')) return;
    if (data.status === 'absent') delete session.attendance[player.id];
    else session.attendance[player.id] = { status: data.status, since: now.toISOString() };
    return;
  }
  if (action === 'createMatch') {
    requireRule(Number.isInteger(data.court) && data.court >= 1 && data.court <= session.courts, 'Lapangan tidak valid.');
    const { teams } = data;
    requireRule(Array.isArray(teams) && teams.length === 2 && teams.every(team => Array.isArray(team) && team.length === 2), 'Isi dua pemain untuk setiap tim.');
    const players = teams.flat();
    const active = activeIds(session);
    const queued = queuedIds(session);
    requireRule(new Set(players).size === 4 && players.every(playerId => playerReady(club, session, playerId) && !active.has(playerId) && !queued.has(playerId)), 'Pilih empat pemain siap yang belum terjadwal.', 409);
    requireRule(!session.matches.some(match => match.court === data.court && match.status === 'queued'), 'Lapangan ini sudah punya laga berikutnya.', 409);
    session.matches.push({ id: id(), court: data.court, teams, status: 'queued', score: null, reports: [], audit: [], revision: 0, code: randomBytes(24).toString('base64url') });
    return;
  }

  const match = session.matches.find(item => item.id === data.matchId);
  requireRule(match, 'Pertandingan tidak ditemukan.', 404);
  if (action === 'startMatch') {
    requireRule(match.status === 'queued', 'Pertandingan sudah berjalan atau selesai.', 409);
    const active = activeIds(session);
    requireRule(!session.matches.some(item => item.court === match.court && item.status === 'active'), 'Lapangan masih dipakai.', 409);
    requireRule(match.teams.flat().every(playerId => !active.has(playerId) && playerReady(club, session, playerId)), 'Ada pemain yang sedang main atau belum siap.', 409);
    match.status = 'active';
    match.startedAt = now.toISOString();
    return;
  }
  if (action === 'finishMatch') {
    requireRule(match.status === 'active', 'Pertandingan belum berjalan atau sudah selesai.', 409);
    match.status = 'finished';
    match.finishedAt = now.toISOString();
    match.finishOrder = ++club.sequence;
    for (const playerId of match.teams.flat()) {
      if (playerReady(club, session, playerId)) session.attendance[playerId].since = match.finishedAt;
    }
    return;
  }
  if (action === 'cancelMatch') {
    requireRule(['queued', 'active', 'finished', 'unscored'].includes(match.status) && !match.score, 'Pertandingan dengan skor resmi tidak bisa dibatalkan.', 409);
    match.status = 'cancelled';
    return;
  }
  throw new RuleError('Tindakan tidak dikenal.');
}

export function lookupMatch(club, code) {
  for (const session of club.sessions) {
    const match = session.matches.find(item => item.code === code);
    if (match) return { session, match };
  }
  throw new RuleError('QR pertandingan tidak ditemukan.', 404);
}

export function canReport(session, match, now) {
  return !session.closed && session.date === day(now) && isTuesday(session.date) && match.status === 'finished' && !match.score;
}

export function addReport(club, code, data, now) {
  const { session, match } = lookupMatch(club, code);
  requireRule(canReport(session, match, now), 'Laporan skor sudah ditutup atau pertandingan belum selesai.', 409);
  requireRule(match.teams.flat().includes(data.playerId), 'Pilih nama pemain di pertandingan ini.');
  requireRule(validScore(data.score), 'Skor belum sesuai aturan satu gim sampai 21, maksimal 30.');
  if (match.reports.some(report => report.playerId === data.playerId && report.status === 'pending' && report.score.every((value, index) => value === data.score[index]))) return;
  requireRule(match.reports.filter(report => report.playerId === data.playerId).length < 8, 'Batas laporan tercapai. Hubungi host untuk pembetulan.', 409);
  requireRule(match.reports.filter(report => report.playerId === data.playerId && report.status === 'pending').length < 3, 'Sudah ada tiga usulan. Hubungi host untuk pembetulan.', 409);
  match.reports.push({ id: id(), playerId: data.playerId, score: data.score, at: now.toISOString(), status: 'pending' });
}

export function addSignup(club, data, now) {
  const date = signupTuesday(club, now);
  requireRule(data.date === date, 'Daftar sesi sudah berganti. Muat ulang halaman.', 409);
  requireRule(club.players.some(player => player.id === data.playerId && !player.archived), 'Pilih nama yang ada di roster.');
  const listed = club.signups[date] ??= [];
  if (!listed.includes(data.playerId)) listed.push(data.playerId);
}

export function clubView(club, now, host = false) {
  const strength = standings(club);
  const roster = club.players.slice().sort(byName).map(player => {
    const stats = strength.get(player.id);
    return {
      id: player.id, name: player.name, nickname: player.nickname, display: label(player), archived: player.archived,
      tier: tierOf(stats.rating), calibration: stats.usesCalibration ? Math.min(5, stats.games) : null, games: stats.games,
      wins: stats.wins, losses: stats.losses, history: stats.history,
      ...(host ? { initialTier: player.initialTier ?? null } : {}),
    };
  });
  const active = roster.filter(player => !player.archived);
  const rankByTier = {};
  const ranked = active.slice().sort((left, right) => strength.get(right.id).rating - strength.get(left.id).rating || byName(left, right))
    .map(player => ({ ...player, rank: rankByTier[player.tier] = (rankByTier[player.tier] ?? 0) + 1 }));
  const signup = courtPlan(club, signupTuesday(club, now));
  const sessionPlan = host ? courtPlan(club, nextTuesday(club, now)) : undefined;
  return {
    players: host ? roster : ranked,
    ...(sessionPlan ? { sessionDate: sessionPlan.date, sessionMinDate: day(now), suggestedSessionCourts: sessionPlan.courts } : {}),
    signup,
    sessions: club.sessions.slice().reverse().map(session => ({
      id: session.id, date: session.date, courts: session.courts, closed: session.closed,
      present: Object.values(session.attendance).filter(record => record.status !== 'absent').length,
      ...(host ? {
        attendance: session.attendance, registered: club.signups[session.date] ?? [],
        canReschedule: !session.closed && !session.matches.some(match => match.startedAt),
      } : {}),
      matches: session.matches.map(match => ({
        id: match.id, court: match.court, status: match.status, finishedAt: match.finishedAt,
        teams: match.teams.map(team => team.map(playerId => {
          const player = roster.find(item => item.id === playerId);
          return { id: player.id, display: player.display, tier: player.tier };
        })),
        score: match.score,
        ...(host ? { revision: match.revision, reports: match.reports, audit: match.audit, reportOpen: canReport(session, match, now) } : {}),
      })),
    })),
  };
}

export function reportView(club, code, now) {
  const { session, match } = lookupMatch(club, code);
  const players = new Map(club.players.map(player => [player.id, label(player)]));
  return {
    open: canReport(session, match, now), date: session.date, court: match.court, score: match.score,
    status: match.status, teams: match.teams.map(team => team.map(playerId => ({ id: playerId, display: players.get(playerId) }))),
  };
}

