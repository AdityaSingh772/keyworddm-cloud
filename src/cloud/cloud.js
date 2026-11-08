#!/usr/bin/env node
'use strict';
// Runs inside the user's GitHub Actions (their own repo, created by the KeywordDM app).
//   node src/cloud/cloud.js once            one check of every running campaign (5-minute schedule)
//   node src/cloud/cloud.js watch           "fast mode": check every 10s for HOURS hours
// Reads data/campaigns.enc (written by the app), writes data/state.enc (read by the app).
// Both are encrypted with KDM_KEY. The Instagram token comes from the IG_ACCESS_TOKEN secret.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApi } = require('../engine/api');
const { createRunner } = require('../main/runner');
const { encrypt, decrypt } = require('../engine/crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = path.join(ROOT, 'data', 'campaigns.enc');
const STATE_PATH = path.join(ROOT, 'data', 'state.enc');
const LOG_KEEP = 50;
const CAMPAIGN_FIELDS = ['name', 'reelUrl', 'mediaId', 'reelTimestamp', 'keyword', 'link', 'message', 'publicReply', 'replies', 'status'];

// ---------- pure helpers (tested) ----------

/** Build the runtime campaign list from the app's config + what the cloud remembers. */
function mergeCampaigns(config, state, existing = []) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  const out = [];
  for (const cfg of (config && config.campaigns) || []) {
    const mem = (state.campaigns || {})[cfg.id] || {};
    const live = byId.get(cfg.id);
    const c = live || {
      id: cfg.id,
      replied: mem.replied || {},
      stats: { sent: 0, skipped: 0, replied: 0, lastCheck: null, lastError: null, ...(mem.stats || {}) },
      log: mem.log || [],
      mediaId: mem.mediaId,
      reelTimestamp: mem.reelTimestamp,
    };
    for (const k of CAMPAIGN_FIELDS) if (cfg[k] !== undefined) c[k] = cfg[k];
    if (mem.mediaId && !c.mediaId) c.mediaId = mem.mediaId;
    // A paused campaign (bad token) stays paused only for this run.
    if (live && live.status === 'paused' && cfg.status === 'running') c.status = 'paused';
    out.push(c);
  }
  return out;
}

/** State to store for each campaign. Keeps entries for campaigns the app no longer lists. */
function buildState(prev, campaigns, extra = {}) {
  const state = { ...prev, ...extra, campaigns: { ...(prev.campaigns || {}) } };
  for (const c of campaigns) {
    state.campaigns[c.id] = {
      mediaId: c.mediaId,
      reelTimestamp: c.reelTimestamp,
      replied: c.replied,
      stats: c.stats,
      log: (c.log || []).slice(0, LOG_KEEP),
    };
  }
  return state;
}

/** Only commit when something real changed (not just "last checked" times). */
function fingerprint(state) {
  const strip = JSON.parse(JSON.stringify(state));
  delete strip.lastRun;
  for (const c of Object.values(strip.campaigns || {})) if (c.stats) delete c.stats.lastCheck;
  return JSON.stringify(strip);
}

// ---------- repo I/O ----------

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=KeywordDM', '-c', 'user.email=keyworddm@users.noreply.github.com', ...args],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function readEnc(file, key, fallback) {
  try {
    return decrypt(fs.readFileSync(file, 'utf8'), key);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Can't decrypt ${path.basename(file)}. Reconnect GitHub in the KeywordDM app. (${e.message})`);
  }
}

function pushState() {
  git('add', 'data/state.enc');
  try {
    git('commit', '-m', 'update DM record', '--quiet');
  } catch {
    return; // nothing to commit
  }
  for (let i = 0; i < 4; i++) {
    try {
      git('pull', '--rebase', '--quiet');
      git('push', '--quiet');
      return;
    } catch (e) {
      if (i === 3) console.error('push failed:', e.message);
    }
  }
}

function pullConfig() {
  try { git('pull', '--rebase', '--quiet'); } catch { /* offline for a moment, try again later */ }
}

// ---------- main ----------

async function main() {
  const mode = process.argv[2] || 'once';
  const key = process.env.KDM_KEY;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!key || !token) {
    console.log('Secrets not set yet (open the KeywordDM app to finish setup). Nothing to do.');
    return;
  }

  let config = readEnc(CFG_PATH, key, { campaigns: [] });
  let state = readEnc(STATE_PATH, key, { campaigns: {} });
  let campaigns = mergeCampaigns(config, state);
  const running = () => campaigns.filter((c) => c.status === 'running');
  if (!running().length && mode === 'once' && !heartbeatDue(state)) {
    console.log('No running campaigns.');
    return;
  }

  const api = createApi(token);
  let account = null;
  let authFailed = false;
  let lastPrint = fingerprint(state);

  const store = {
    campaigns: () => campaigns,
    save: async () => {
      state = buildState(state, campaigns, { lastRun: new Date().toISOString(), authError: authFailed || undefined });
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      const fp = fingerprint(state);
      if (fp !== lastPrint || !fs.existsSync(STATE_PATH)) {
        fs.writeFileSync(STATE_PATH, encrypt(state, key));
        lastPrint = fp;
        dirty = true;
      }
    },
  };
  let dirty = false;

  const runner = createRunner({
    store,
    getApi: async () => {
      if (!account) account = await api.account(config.igUserId);
      return { api, account };
    },
    onChange: () => {},
    onAuthError: () => { authFailed = true; },
    fixedInterval: mode === 'watch' ? 10_000 : null, // fast mode: every 10s, whatever the reel's age
  });

  const flush = async () => {
    await store.save();
    if (dirty) { pushState(); dirty = false; }
  };

  if (mode === 'once') {
    if (heartbeatDue(state)) { state.lastHeartbeat = new Date().toISOString(); lastPrint = ''; }
    await runner._tick();
    await flush();
    report();
    if (authFailed) process.exit(1);
    return;
  }

  // watch ("fast mode")
  const hours = Math.min(Math.max(Number(process.env.HOURS || 5) || 5, 0.1), 5.5);
  const endAt = Date.now() + hours * 3600e3;
  let idleSince = null;
  let stopping = false;
  const stop = async (why) => {
    if (stopping) return;
    stopping = true;
    runner.stop();
    console.log(`fast mode ending: ${why}`);
    await flush();
    report();
    process.exit(authFailed ? 1 : 0);
  };
  process.on('SIGINT', () => stop('cancelled'));
  process.on('SIGTERM', () => stop('cancelled'));

  console.log(`fast mode for ${hours}h, checking every 10s`);
  runner.start();
  setInterval(async () => {
    if (stopping) return;
    pullConfig(); // pick up campaigns started or stopped in the app
    config = readEnc(CFG_PATH, key, config);
    campaigns = mergeCampaigns(config, state, campaigns);
    if (dirty) { pushState(); dirty = false; }
    if (authFailed) return stop('Instagram rejected the token');
    if (Date.now() > endAt) return stop('time is up');
    if (!running().length) {
      idleSince = idleSince || Date.now();
      if (Date.now() - idleSince > 10 * 60e3) return stop('no running campaigns');
    } else idleSince = null;
  }, 20_000);

  function report() {
    for (const c of campaigns) console.log(`${c.keyword}: ${c.stats.sent} sent, ${c.stats.skipped} skipped${c.stats.lastError ? `, last error: ${c.stats.lastError}` : ''}`);
  }
}

function heartbeatDue(state) {
  // GitHub pauses schedules in repos with no commits for 60 days; commit once a week.
  return Date.now() - (Date.parse(state.lastHeartbeat || 0) || 0) > 6 * 24 * 3600e3;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { mergeCampaigns, buildState, fingerprint, heartbeatDue };
