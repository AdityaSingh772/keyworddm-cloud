'use strict';
// Runs every active campaign on a schedule while the app is open.
// One check at a time (never two in parallel), paced by reel age, with backoff when
// Instagram says we're calling too often. Stops everything if the token is rejected.
const { checkCampaign, checkDMs, intervalFor, isAuthError, isRateLimited } = require('../engine/engine');

const LOG_LIMIT = 200;

// fixedInterval: check every campaign this often regardless of reel age (fast mode).
function createRunner({ store, getApi, onChange, onAuthError, onFirstSend, now = Date.now, fixedInterval = null }) {
  let timer = null;
  let busy = false;
  let pauseUntil = 0;
  let backoff = 0;
  const nextAt = new Map(); // campaign id -> ms
  let dmNextAt = 0; // inbox scan for people who DM the keyword
  let dmLastScan = 0;
  let dmBackoff = 0;

  function addLog(c, kind, text) {
    c.log = c.log || [];
    c.log.unshift({ at: new Date(now()).toISOString(), kind, text });
    if (c.log.length > LOG_LIMIT) c.log.length = LOG_LIMIT;
  }

  // Counts come from the answered-comments record, so they stay right even if a
  // check stops halfway (rate limit, crash).
  function recount(c) {
    const vals = Object.values(c.replied || {});
    const sentNow = vals.filter((v) => !String(v).startsWith('error')).length;
    c.stats.sent = (c.prunedSent || 0) + sentNow;
    c.stats.skipped = (c.prunedSkipped || 0) + (vals.length - sentNow);
  }

  function running() {
    return store.campaigns().filter((c) => c.status === 'running');
  }

  async function tick() {
    if (busy) return;
    const t = now();
    if (t < pauseUntil) return;
    const due = running().filter((c) => (nextAt.get(c.id) || 0) <= t);
    const dmCampaigns = running().filter((c) => c.dmKeyword !== false);
    const dmDue = dmCampaigns.length > 0 && dmNextAt <= t;
    if (!due.length && !dmDue) return;
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
        nextAt.set(c.id, now() + (fixedInterval || intervalFor(c.reelTimestamp, now())));
        await store.save();
        onChange();
      }
      if (dmDue && running().some((c) => c.dmKeyword !== false)) {
        const scanStart = now();
        const sentBefore = new Map(dmCampaigns.map((c) => [c.id, c.stats.sent || 0]));
        try {
          const r = await checkDMs({
            api, account, campaigns: running(), now: scanStart, since: dmLastScan,
            save: () => store.save(),
            log: (c, kind, text) => { addLog(c, kind, text); onChange(); },
          });
          dmLastScan = scanStart;
          dmBackoff = 0;
          dmNextAt = now() + Math.max(fixedInterval || 60_000, 30_000);
          for (const c of dmCampaigns) {
            c.stats.dmError = null;
            recount(c);
            if (r.sent && onFirstSend && !sentBefore.get(c.id) && c.stats.sent > 0) onFirstSend(c);
          }
        } catch (e) {
          if (isAuthError(e)) {
            for (const x of running()) x.status = 'paused';
            for (const c of dmCampaigns) c.stats.lastError = 'Instagram rejected the access token. Reconnect in Settings.';
            await store.save();
            onChange();
            onAuthError(e);
            return;
          }
          // Never let the inbox scan hold up comment checks: just try it again later.
          dmBackoff = Math.min(Math.max(dmBackoff * 2, isRateLimited(e) ? 300_000 : 120_000), 1_800_000);
          dmNextAt = now() + dmBackoff;
          const msg = `Couldn't read DMs: ${e.apiMessage || e.message || String(e)}`;
          for (const c of dmCampaigns) {
            if (c.stats.dmError !== msg) addLog(c, 'error', msg);
            c.stats.dmError = msg;
          }
        }
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
