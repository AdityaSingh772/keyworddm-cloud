'use strict';
// Runs every active campaign on a schedule while the app is open.
// One check at a time (never two in parallel), paced by reel age, with backoff when
// Instagram says we're calling too often. Stops everything if the token is rejected.
const { checkCampaign, intervalFor, isAuthError, isRateLimited } = require('../engine/engine');

const LOG_LIMIT = 200;

function createRunner({ store, getApi, onChange, onAuthError, onFirstSend, now = Date.now }) {
  let timer = null;
  let busy = false;
  let pauseUntil = 0;
  let backoff = 0;
  const nextAt = new Map(); // campaign id -> ms

  function addLog(c, kind, text) {
    c.log = c.log || [];
    c.log.unshift({ at: new Date(now()).toISOString(), kind, text });
    if (c.log.length > LOG_LIMIT) c.log.length = LOG_LIMIT;
  }

  // Counts come from the answered-comments record, so they stay right even if a
  // check stops halfway (rate limit, crash).
  function recount(c) {
    const vals = Object.values(c.replied || {});
    c.stats.sent = vals.filter((v) => !String(v).startsWith('error')).length;
    c.stats.skipped = vals.length - c.stats.sent;
  }

  function running() {
    return store.campaigns().filter((c) => c.status === 'running');
  }

  async function tick() {
    if (busy) return;
    const t = now();
    if (t < pauseUntil) return;
    const due = running().filter((c) => (nextAt.get(c.id) || 0) <= t);
    if (!due.length) return;
    busy = true;
    try {
      const { api, account } = await getApi();
      for (const c of due) {
        if (c.status !== 'running') continue;
        try {
          const r = await checkCampaign({
            api, account, campaign: c, now: now(),
            save: () => store.save(),
            log: (kind, text) => { addLog(c, kind, text); onChange(); },
          });
          const before = c.stats.sent;
          recount(c);
          c.stats.replied += r.replied;
          c.stats.lastCheck = new Date(now()).toISOString();
          c.stats.lastError = null;
          if (before === 0 && r.sent > 0 && onFirstSend) onFirstSend(c);
          backoff = 0;
        } catch (e) {
          c.stats.lastCheck = new Date(now()).toISOString();
          if (isAuthError(e)) {
            for (const x of running()) x.status = 'paused';
            c.stats.lastError = 'Instagram rejected the access token. Reconnect in Settings.';
            addLog(c, 'error', c.stats.lastError);
            await store.save();
            onChange();
            onAuthError(e);
            return;
          }
          if (isRateLimited(e)) {
            backoff = Math.min(Math.max(backoff * 2, 60_000), 900_000);
            pauseUntil = now() + backoff;
            c.stats.lastError = `Instagram asked us to slow down. Pausing ${Math.round(backoff / 1000)}s.`;
          } else {
            backoff = Math.min(Math.max(backoff * 2, 15_000), 300_000);
            pauseUntil = now() + backoff;
            c.stats.lastError = e.apiMessage || e.message || String(e);
          }
          addLog(c, 'error', c.stats.lastError);
        }
        recount(c);
        nextAt.set(c.id, now() + intervalFor(c.reelTimestamp, now()));
        await store.save();
        onChange();
      }
    } catch (e) {
      // Couldn't even build the API client (no token, network down at startup).
      backoff = Math.min(Math.max(backoff * 2, 15_000), 300_000);
      pauseUntil = now() + backoff;
      if (isAuthError(e)) onAuthError(e);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (!timer) timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    checkNow(id) {
      nextAt.set(id, 0);
      pauseUntil = 0;
      return tick();
    },
    isActive: () => running().length > 0,
    _tick: tick, // for tests
  };
}

module.exports = { createRunner };
