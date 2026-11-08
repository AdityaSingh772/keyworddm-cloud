'use strict';
// Thin client for Meta's official Instagram APIs. No third-party packages.
//
// Two token types are supported and detected automatically:
//  - Unified login (default for Meta apps created since 2026): host graph.facebook.com,
//    a system-user token that can be set to never expire. /me is a system user, so the
//    Instagram account comes from /me/assigned_instagram_accounts.
//  - Instagram login (older apps): host graph.instagram.com, 60-day tokens that start
//    with "IG" and can be refreshed.

const VERSION = 'v27.0';

class ApiError extends Error {
  constructor(status, body) {
    super(`Instagram API error ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = String(body);
    try {
      const err = JSON.parse(this.body).error || {};
      this.code = err.code;
      this.subcode = err.error_subcode;
      this.apiMessage = err.message;
    } catch {
      this.code = undefined;
    }
  }
}

function detectLogin(token) {
  return /^IG/.test(String(token).trim()) ? 'instagram' : 'unified';
}

function createApi(token, { fetchImpl = globalThis.fetch, login } = {}) {
  token = String(token || '').trim();
  if (!token) throw new Error('No access token');
  login = login || detectLogin(token);
  const host = login === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';

  async function request(method, url, payload) {
    const headers = { Authorization: `Bearer ${token}` };
    let body;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  function url(path, params) {
    let u = /^https?:/.test(path) ? path : `${host}/${VERSION}/${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      u += (u.includes('?') ? '&' : '?') + qs;
    }
    return u;
  }

  const api = {
    login,
    host,
    get: (path, params) => request('GET', url(path, params)),
    post: (path, payload) => request('POST', url(path), payload),

    /** Your Instagram professional account: { id, username } */
    async account(preferredId) {
      if (login === 'instagram') {
        const me = await api.get('me', { fields: 'user_id,username' });
        return { id: me.user_id || me.id, username: me.username || '' };
      }
      const res = await api.get('me/assigned_instagram_accounts', { fields: 'id,username' });
      let accts = res.data || [];
      if (preferredId) accts = accts.filter((a) => a.id === preferredId).concat(accts);
      if (!accts.length) {
        throw new Error('This token cannot see any Instagram account. Generate it again and select your Instagram account when Meta asks.');
      }
      return { id: accts[0].id, username: accts[0].username || '', all: res.data };
    },

    /** Recent posts, newest first, for the reel picker. */
    async recentMedia(igId, limit = 24) {
      const res = await api.get(`${igId}/media`, {
        fields: 'id,permalink,timestamp,caption,media_type,media_product_type,thumbnail_url,media_url',
        limit,
      });
      return res.data || [];
    },

    /** Only for Instagram-login tokens: returns { access_token, expires_in }. */
    async refresh() {
      if (login !== 'instagram') return null;
      return request('GET', `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
    },
  };
  return api;
}

module.exports = { createApi, detectLogin, ApiError, VERSION };
