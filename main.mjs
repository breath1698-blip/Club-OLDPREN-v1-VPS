import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './server.mjs';

const env = process.env;
const database = env.DATABASE_PATH || './data/club.sqlite';
const port = Number(env.PORT || 3000);
const bind = env.BIND || '127.0.0.1';
mkdirSync(dirname(database), { recursive: true });
const { app, db } = createApp({
  database, groupKey: env.GROUP_KEY, publicUrl: env.APP_URL || 'http://localhost:' + port,
  allowLocalBootstrap: bind === '127.0.0.1' || bind === '::1',
  accounts: [
    { name: env.HOST_MAIN_NAME, password: env.HOST_MAIN_PASSWORD },
    { name: env.HOST_BACKUP_NAME, password: env.HOST_BACKUP_PASSWORD },
  ],
});
const server = app.listen(port, bind, () => console.log('Club OLDPREN mendengarkan di ' + bind + ':' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => db.close()));
