// 401 / 403 的诊断文案：区分 Cloudflare 页、JSON 错误、直连 / 中继。
const test = require('node:test');
const assert = require('node:assert');

function response({ status = 403, body = '', headers = {} }) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: false, status, statusText: 'X', headers: { get: k => map.get(String(k).toLowerCase()) ?? null }, text: async () => body };
}
async function rejection(env, resp) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const realFetch = globalThis.fetch; globalThis.fetch = async () => resp;
  try { await require('../api/_predict-graphql').predictGraphql({ query: '{ x }' }); throw new Error('should reject'); }
  catch (err) { return err; }
  finally { globalThis.fetch = realFetch; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('Cloudflare HTML 403（经中继）→ 指出是拦截页与 Ray ID，不提凭证', async () => {
  const html = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Cloudflare Ray ID: <strong>8d1234567890abcd-SIN</strong></body></html>';
  const err = await rejection({ PREDICT_GRAPHQL_RELAY_URL: 'https://r.example', PREDICT_GRAPHQL_RELAY_TOKEN: 't' }, response({ body: html, headers: { 'x-upstream-server': 'cloudflare' } }));
  assert.match(err.message, /via relay https:\/\/r\.example\/graphql/);
  assert.match(err.message, /Cloudflare block page \(Ray ID 8d1234567890abcd-SIN\)/);
  assert.doesNotMatch(err.message, /COOKIE may be missing/);
  assert.strictEqual(err.status, 502);
});

test('JSON 403（直连）→ 带上游的错误文案', async () => {
  const err = await rejection({ PREDICT_GRAPHQL_RELAY_URL: undefined }, response({ body: '{"errors":[{"message":"Forbidden: origin not allowed"}]}' }));
  assert.match(err.message, /direct from Vercel/);
  assert.match(err.message, /JSON: Forbidden: origin not allowed/);
});

test('纯文本 401 → 带片段', async () => {
  const err = await rejection({ PREDICT_GRAPHQL_RELAY_URL: undefined }, response({ status: 401, body: 'Unauthorized access' }));
  assert.match(err.message, /HTTP 401, direct from Vercel\): upstream answered 401 — Unauthorized access/);
});
