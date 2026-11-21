import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const key = () => randomBytes(24).toString('base64url');
try {
  writeFileSync('.env', [
    'APP_URL=http://localhost:3000',
    'PORT=3000',
    'BIND=127.0.0.1',
    'DATABASE_PATH=./data/club.sqlite',
    'GROUP_KEY=' + key(),
    'HOST_MAIN_NAME=hostutama',
    'HOST_MAIN_PASSWORD=' + key(),
    'HOST_BACKUP_NAME=hostkedua',
    'HOST_BACKUP_PASSWORD=' + key(),
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Konfigurasi .env sudah dibuat. Buka file itu di perangkat sendiri untuk melihat akun host.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Konfigurasi .env sudah ada.');
}
