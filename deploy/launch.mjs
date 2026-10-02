// Container start-up. Persistent disks (Render, Docker volumes, host folders) are often
// owned by root: make the data folder writable for the unprivileged "node" user, drop
// root privileges, and only then start the app.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

if (process.getuid?.() === 0) {
  const dataDir = dirname(process.env.DB_FILE || '/data/voorraad.db');
  execFileSync('mkdir', ['-p', dataDir]);
  execFileSync('chown', ['-R', 'node:node', dataDir]);
  if (process.env.BACKUP_DIR) {
    execFileSync('mkdir', ['-p', process.env.BACKUP_DIR]);
    execFileSync('chown', ['-R', 'node:node', process.env.BACKUP_DIR]);
  }
  process.initgroups('node', 'node');
  process.setgid('node');
  process.setuid('node');
}

await import('../src/index.js');
