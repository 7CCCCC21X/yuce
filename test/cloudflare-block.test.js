// Cloudflare 拦截页识别 单元测试（api/_predict-graphql.js detectCloudflareBlock）。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');
const { detectCloudflareBlock } = require('../api/_predict-graphql');

function fakeResponse(headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: k => map.get(String(k).toLowerCase()) ?? null } };
}

test('detectCloudflareBlock: 识别 Attention Required 拦截页', () => {
  const html = '<!DOCTYPE html>\n<html class="no-js" lang="en-US"><head><title>Attention Required! | Cloudflare</title></head>'
    + '<body><span class="cf-error-code">1020</span><span class="cf-footer-item">Cloudflare Ray ID: <strong>8d1234567890abcd</strong></span></body></html>';
  const cf = detectCloudflareBlock(fakeResponse({ server: 'cloudflare' }), html);
  assert.ok(cf);
  assert.strictEqual(cf.code, '1020');
  assert.strictEqual(cf.ray, '8d1234567890abcd');
  assert.strictEqual(cf.challenge, false);
});

test('detectCloudflareBlock: 识别 JS 挑战页，优先用 cf-ray 响应头', () => {
  const html = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>';
  const cf = detectCloudflareBlock(fakeResponse({ 'cf-ray': 'abcdef123456-HKG' }), html);
  assert.ok(cf);
  assert.strictEqual(cf.challenge, true);
  assert.strictEqual(cf.ray, 'abcdef123456-HKG');
});

test('detectCloudflareBlock: 没有 cloudflare 迹象的 HTML / 普通 JSON 不误判', () => {
  assert.strictEqual(detectCloudflareBlock(fakeResponse(), '{"errors":[{"message":"Forbidden"}]}'), null);
  assert.strictEqual(detectCloudflareBlock(fakeResponse(), '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), null);
  // 纯文本里提到 cloudflare 但不是 HTML 页，也不算拦截页
  assert.strictEqual(detectCloudflareBlock(fakeResponse({ server: 'cloudflare' }), 'Forbidden'), null);
});

test('美国节点（Ray ID -IAD）被拒时，错误信息提示改 Vercel 区域', async () => {
  const { predictGraphql } = require('../api/_predict-graphql');
  const html = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, ok: false, headers: { get: k => (String(k).toLowerCase() === 'cf-ray' ? 'a4cccfca3fd4ec03-IAD' : null) }, text: async () => html });
  try {
    await assert.rejects(
      () => predictGraphql({ query: '{ x }', variables: {}, operationName: 'X' }),
      err => /Cloudflare blocked the request/.test(err.message) && /Ray ID a4cccfca3fd4ec03-IAD/.test(err.message) && /US location \(IAD\)/.test(err.message) && /sin1/.test(err.message) && err.status === 502
    );
  } finally { globalThis.fetch = realFetch; }
});

test('非美国节点被拒时不提示区域', async () => {
  const { predictGraphql } = require('../api/_predict-graphql');
  const html = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 403, ok: false, headers: { get: k => (String(k).toLowerCase() === 'cf-ray' ? 'a4cccfca3fd4ec03-SIN' : null) }, text: async () => html });
  try {
    await assert.rejects(() => predictGraphql({ query: '{ x }', variables: {}, operationName: 'X' }), err => /Cloudflare blocked/.test(err.message) && !/US location/.test(err.message));
  } finally { globalThis.fetch = realFetch; }
});
