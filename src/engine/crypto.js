'use strict';
// AES-256-GCM for the files KeywordDM keeps in the user's public GitHub repo
// (campaign settings and the DM record). Anyone can see the repo, nobody can read these.
// The key lives in the app (Keychain) and in the repo's encrypted Actions secret KDM_KEY.
const crypto = require('crypto');

function newKey() {
  return crypto.randomBytes(32).toString('base64');
}

function encrypt(obj, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('Bad encryption key');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
}

function decrypt(text, keyB64) {
  const box = JSON.parse(text);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

module.exports = { newKey, encrypt, decrypt };
