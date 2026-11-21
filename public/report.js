import { api, layout, hero, esc, dateText, badge, teams, scoreText, bindForm, field } from './ui.js?v=6';

export async function report(path) {
  const endpoint = '/api/report/' + path.split('/')[2];
  let data = await api(endpoint);
  let sent = false;
  function render() {
    const options = data.teams.flat().map(player => '<option value="' + esc(player.id) + '">' + esc(player.display) + '</option>').join('');
    layout('<div class="narrow">' + hero('Lapor', 'Skor', dateText(data.date) + ' · Lapangan ' + data.court) +
      '<section class="panel matchup"><h2>Ringkasan pertandingan</h2>' + teams(data) + '</section>' +
      (sent ? '<section class="panel outcome">' + badge('Menunggu host') + '<h2>Usulan skor terkirim</h2><p>Host akan mengecek dan mengesahkan hasilnya.</p></section>' :
        data.open ? '<form id="report" class="panel stack"><h2>Masukkan skor akhir</h2><label>Nama lo di pertandingan ini<select name="player" required><option value="">Pilih nama</option>' +
          options + '</select></label><div class="score-fields">' +
          field('a', 'Skor Tim A', 'required type="number" inputmode="numeric" min="0" max="30"') +
          field('b', 'Skor Tim B', 'required type="number" inputmode="numeric" min="0" max="30"') +
          '</div><button class="button solid full">Kirim usulan skor</button><p class="muted">Skor jadi resmi setelah dicek host.</p></form>' :
          '<section class="panel outcome"><h2>' + (data.score ? 'Skor resmi ' + scoreText(data.score) : 'Laporan skor belum tersedia atau sudah ditutup') + '</h2>' +
          '<p>' + (data.score ? 'Hasil sudah disahkan host.' : 'Lapor setelah laga selesai, selama sesi Selasa masih buka.') + '</p></section>') + '</div>');
    bindForm('report', async form => {
      try {
        await api(endpoint, { playerId: form.get('player'), score: [Number(form.get('a')), Number(form.get('b'))] });
        sent = true;
        render();
      } catch (error) {
        if (error.status === 409) {
          data = await api(endpoint);
          if (!data.open) render();
        }
        throw error;
      }
    });
  }
  render();
}
