'use strict';
// Comment-to-DM logic. Pure where possible so it can be tested without Instagram.
//
// Meta's rules (Private Replies docs): one private reply per comment, sent within
// 7 days of the comment. It lands in the Inbox if the commenter follows the account,
// otherwise in their message Requests.

const REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const SAFETY_MARGIN_MS = 3600 * 1000; // don't try at 6d 23h 59m
const MAX_PAGES = 40; // 40 x 50 = 2,000 comments per reel per check
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive. "test" matches "TEST pls" but not "testing". */
function matchesKeyword(text, keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(kw)}($|[^\\p{L}\\p{N}_])`, 'iu').test(String(text || ''));
}

function parseTs(ts) {
  // Instagram uses 2026-11-08T21:24:05+0000; some endpoints send unix seconds.
  if (typeof ts === 'number' || /^\d+$/.test(String(ts))) { const n = Number(ts); return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(String(ts).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(t) ? 0 : t;
}

function stillInWindow(ts, now) {
  return now - parseTs(ts) < REPLY_WINDOW_MS - SAFETY_MARGIN_MS;
}

/** "https://www.instagram.com/reel/DfcYgW2NlXS/?igsh=x" -> "DfcYgW2NlXS" */
function shortcode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function isValidLink(link) {
  try {
    const u = new URL(String(link).trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function pickComments(comments, keyword, ownUsername, doneIds, now) {
  const seen = new Set();
  const out = [];
  for (const c of comments) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    if (doneIds.has(c.id)) continue;
    if (ownUsername && String(c.username || '').toLowerCase() === ownUsername.toLowerCase()) continue;
    if (!stillInWindow(c.timestamp, now)) continue;
    if (!matchesKeyword(c.text, keyword)) continue;
    out.push(c);
  }
  return out.reverse(); // oldest first, so early commenters are answered first
}

/** Replace {link} in the message; append the link if the placeholder is missing. */
function buildMessage(template, link) {
  const t = String(template || '').trim();
  const l = String(link || '').trim();
  if (!l) return t;
  return t.includes('{link}') ? t.split('{link}').join(l) : `${t}\n\n${l}`;
}

/** Rotate public replies by comment id so the same text isn't posted hundreds of times. */
function pickReply(options, commentId) {
  const list = (options || []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return null;
  const digits = String(commentId).replace(/\D/g, '').slice(-9) || '0';
  return list[Number(digits) % list.length];
}

function isAuthError(e) {
  return !!e && (e.status === 401 || e.code === 190);
}
function isRateLimited(e) {
  return !!e && (e.status === 429 || RATE_LIMIT_CODES.has(e.code));
}

async function findMediaId(api, igId, reelUrl) {
  const want = shortcode(reelUrl);
  if (!want) throw new Error(`That doesn't look like a reel link: ${reelUrl}`);
  let page = await api.get(`${igId}/media`, { fields: 'id,permalink,timestamp', limit: 50 });
  for (let i = 0; i < 6; i++) {
    for (const m of page.data || []) if (shortcode(m.permalink) === want) return { id: m.id, timestamp: m.timestamp };
    const next = page.paging && page.paging.next;
    if (!next) break;
    page = await api.get(next);
  }
  throw new Error('Reel not found on this account. Check the link is from your own profile.');
}

async function fetchRecentComments(api, mediaId, now) {
  const comments = [];
  let page = await api.get(`${mediaId}/comments`, { fields: 'id,text,timestamp,username', limit: 50 });
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = page.data || [];
    comments.push(...data);
    if (data.length && !stillInWindow(data[data.length - 1].timestamp, now)) break;
    const next = page.paging && page.paging.next;
    if (!next) break;
    page = await api.get(next);
  }
  return comments;
}

/**
 * Check one campaign once. Mutates campaign.replied / campaign.mediaId and calls
 * save() after every DM so a crash never sends twice.
 * Throws on auth errors and rate limits (the runner decides what to do).
 */
async function checkCampaign({ api, account, campaign, now = Date.now(), dryRun = false,
  save = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  campaign.replied = campaign.replied || {};
  if (!campaign.mediaId) {
    const media = await findMediaId(api, account.id, campaign.reelUrl);
    campaign.mediaId = media.id;
    campaign.reelTimestamp = parseTs(media.timestamp) || null;
    await save();
  }
  const comments = await fetchRecentComments(api, campaign.mediaId, now);
  const todo = pickComments(comments, campaign.keyword, account.username, new Set(Object.keys(campaign.replied)), now);
  const result = { matches: todo.length, sent: 0, skipped: 0, replied: 0, preview: [] };
  if (dryRun) {
    result.preview = todo.map((c) => ({ id: c.id, username: c.username, text: c.text, timestamp: c.timestamp }));
    return result;
  }
  const text = buildMessage(campaign.message, campaign.link);
  for (const c of todo) {
    try {
      const res = await api.post(`${account.id}/messages`, { recipient: { comment_id: c.id }, message: { text } });
      campaign.replied[c.id] = new Date(now).toISOString();
      // Remember who got it, so the same person DMing the keyword isn't sent it twice.
      if (res && res.recipient_id) (campaign.dmUsers = campaign.dmUsers || {})[res.recipient_id] = new Date(now).toISOString();
      result.sent++;
      log('sent', `DM sent to @${c.username || 'someone'}`);
    } catch (e) {
      if (isAuthError(e) || isRateLimited(e) || !e.status || e.status >= 500) {
        await save();
        throw e;
      }
      // Already replied, comment deleted, user can't be messaged: don't retry forever.
      campaign.replied[c.id] = `error:${e.status}`;
      result.skipped++;
      log('skip', `Couldn't DM @${c.username || 'someone'}: ${e.apiMessage || e.status}`);
      await save();
      continue;
    }
    await save();
    if (campaign.publicReply) {
      const reply = pickReply(campaign.replies, c.id);
      if (reply) {
        try {
          await api.post(`${c.id}/replies`, { message: reply });
          result.replied++;
        } catch (e) {
          if (isAuthError(e)) throw e;
          log('skip', `DM sent, but the public reply failed: ${e.apiMessage || e.status}`);
        }
      }
    }
    await sleep(1500); // be gentle with rate limits
  }
  return result;
}

// ---------- keyword sent by DM ----------
// Instagram sometimes limits a comment so only its author sees it, and no app ever
// receives it. Those people can DM the keyword instead and still get the link.

const DM_WINDOW_MS = 23 * 3600 * 1000; // Instagram allows replies within 24h of their message

/**
 * Scan the inbox once for every campaign that answers DMs. A person gets each
 * campaign's link once. Messages from before the campaign started are ignored.
 * Throws API errors; the runner decides what to do with them.
 */
async function checkDMs({ api, account, campaigns, now = Date.now(), since = 0, save = async () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const active = campaigns.filter((c) => c.status === 'running' && c.dmKeyword !== false && c.keyword);
  const result = { conversations: 0, sent: 0 };
  if (!active.length) return result;
  // Newest conversations first. Keep paging while they're newer than the last scan
  // (busy launches, where our own replies also bump conversations to the top).
  const floor = Math.max(now - DM_WINDOW_MS, (since || 0) - 5 * 60e3);
  const convs = [];
  let page = await api.get(`${account.id}/conversations`, {
    platform: 'instagram', limit: 50,
    fields: 'updated_time,messages.limit(5){id,message,from,created_time}',
  });
  for (let i = 0; i < 6; i++) {
    const data = page.data || [];
    convs.push(...data);
    const last = data[data.length - 1];
    if (!last || parseTs(last.updated_time) < floor || !(page.paging && page.paging.next)) break;
    page = await api.get(page.paging.next);
  }
  result.conversations = convs.length;
  // Oldest first, so whoever asked first is answered first.
  const msgs = [];
  for (const conv of convs) {
    if (now - parseTs(conv.updated_time) > DM_WINDOW_MS) continue;
    for (const m of (conv.messages && conv.messages.data) || []) {
      const from = m.from || {};
      if (!from.id || from.id === account.id) continue;
      if (account.username && String(from.username || '').toLowerCase() === account.username.toLowerCase()) continue;
      const at = parseTs(m.created_time);
      if (!at || now - at > DM_WINDOW_MS) continue;
      msgs.push({ id: m.id, text: m.message || '', at, userId: from.id, username: from.username || '' });
    }
  }
  msgs.sort((a, b) => a.at - b.at);
  for (const m of msgs) {
    for (const c of active) {
      c.replied = c.replied || {};
      c.dmUsers = c.dmUsers || {};
      if (c.dmUsers[m.userId] || c.replied[`dm:${m.id}`]) continue;
      const started = Date.parse(c.createdAt || 0) || 0;
      if (m.at < started) continue;
      if (!matchesKeyword(m.text, c.keyword)) continue;
      const stamp = new Date(now).toISOString();
      try {
        await api.post(`${account.id}/messages`, { recipient: { id: m.userId }, message: { text: buildMessage(c.message, c.link) } });
        c.replied[`dm:${m.id}`] = stamp;
        result.sent++;
        log(c, 'sent', `DM sent to @${m.username || 'someone'} (they messaged the keyword)`);
      } catch (e) {
        if (isAuthError(e) || isRateLimited(e) || !e.status || e.status >= 500) { await save(); throw e; }
        c.replied[`dm:${m.id}`] = `error:${e.status}`;
        log(c, 'skip', `Couldn't reply to @${m.username || 'someone'}'s DM: ${e.apiMessage || e.status}`);
      }
      c.dmUsers[m.userId] = stamp;
      await save();
      await sleep(1500);
    }
  }
  return result;
}

/** How often to check, based on how old the reel is. Most keyword comments come early. */
function intervalFor(reelTimestampMs, now, base = {}) {
  const age = reelTimestampMs ? now - reelTimestampMs : 0;
  const h = 3600 * 1000;
  if (age < 6 * h) return base.fresh || 10_000;
  if (age < 48 * h) return base.warm || 60_000;
  return base.old || 300_000;
}

module.exports = {
  matchesKeyword, shortcode, stillInWindow, parseTs, pickComments, buildMessage, pickReply,
  isAuthError, isRateLimited, isValidLink, findMediaId, fetchRecentComments, checkCampaign, checkDMs,
  intervalFor, REPLY_WINDOW_MS,
};
