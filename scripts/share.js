#!/usr/bin/env node
'use strict';
// One command to run the league from your own computer and get a link for friends:
//   npm run share
// Starts the server, opens a free Cloudflare tunnel, and (on a Mac) keeps the computer
// from sleeping while it runs. Ctrl+C stops everything.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;
const root = path.join(__dirname, '..');
const kids = [];
function stop() { for (const k of kids) { try { k.kill(); } catch (e) { /* already gone */ } } process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT) } });
kids.push(server);
server.stderr.pipe(process.stderr);
server.on('exit', () => { console.log('\nThe server stopped.'); stop(); });

if (process.platform === 'darwin') kids.push(spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore' }));

let invite = '', started = false;
server.stdout.on('data', (d) => {
  const m = /Invite code: (\w+)/.exec(String(d));
  if (m && !started) { invite = m[1]; started = true; startTunnel(); }
});

function startTunnel() {
  const hasBinary = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).status === 0;
  const args = ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'];
  const tunnel = hasBinary ? spawn('cloudflared', args) : spawn('npx', ['--yes', 'cloudflared', ...args]);
  kids.push(tunnel);
  let shown = false;
  const scan = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    if (m && !shown) {
      shown = true;
      console.log(`
  Courtside is running.

  Send friends this link:   ${m[0]}
  Invite code:              ${invite}
  On this computer:         http://localhost:${PORT}

  The link changes every time you start this. Keep this window open and the
  computer plugged in. Press Ctrl+C to stop.
`);
    }
  };
  tunnel.stdout.on('data', scan); tunnel.stderr.on('data', scan);
  tunnel.on('exit', () => { if (!shown) console.log('\nCould not open a tunnel. Install cloudflared (brew install cloudflared) and try again. The app still runs at http://localhost:' + PORT); });
  setTimeout(() => { if (!shown) console.log('Still waiting for the tunnel. If nothing appears, check your internet connection.'); }, 30000);
}
