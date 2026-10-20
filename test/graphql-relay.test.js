// _predict-graphql.js 的中继路由：配置 PREDICT_GRAPHQL_RELAY_URL 后改发到中继。
// 运行：npm test

const test = require('node:test');
const assert = require('node:assert');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

function response({ status = 200, body = '', headers = {} }) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, statusText: 'X', headers: { get: k => map.get(String(k).toLowerCase()) ?? null }, text: async () => body };
}

test('配置中继后：POST 到 <relay>/graphql，带 x-relay-token，响应原样解析', async () => {
  const { predictGraphql } = require('../api/_predict-graphql');
  await withEnv({ PREDICT_GRAPHQL_RELAY_URL: 'https://relay.example.app/', PREDICT_GRAPHQL_RELAY_TOKEN: 'tok' }, async () => {
    const realFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, init) => { seen = { url: String(url), init }; return response({ body: JSON.stringify({ data: { account: { name: 'bob' } } }) }); };
    try {
      const json = await predictGraphql({ query: '{ x }', variables: { a: 1 }, operationName: 'X' });
      assert.strictEqual(json.data.account.name, 'bob');
      assert.strictEqual(seen.url, 'https://relay.example.app/graphql');
      assert.strictEqual(seen.init.method, 'POST');
      assert.strictEqual(seen.init.headers['x-relay-token'], 'tok');
      assert.deepStrictEqual(JSON.parse(seen.init.body), { query: '{ x }', variables: { a: 1 }, operationName: 'X' });
    } finally { globalThis.fetch = realFetch; }
  });
});

test('中继自身错误（x-relay-error）→ 明确提示中继失败，而不是"凭证过期"', async () => {
  const { predictGraphql } = require('../api/_predict-graphql');
  await withEnv({ PREDICT_GRAPHQL_RELAY_URL: 'https://relay.example.app', PREDICT_GRAPHQL_RELAY_TOKEN: 'wrong' }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => response({ status: 401, headers: { 'x-relay-error': '1' }, body: JSON.stringify({ success: false, error: 'relay token missing or invalid', relay: true }) });
    try {
      await assert.rejects(() => predictGraphql({ query: '{ x }' }), err => /GraphQL relay .*failed: relay token missing or invalid/.test(err.message) && err.status === 502 && !/PREDICT_GRAPHQL_AUTH/.test(err.message));
    } finally { globalThis.fetch = realFetch; }
  });
});

test('中继透传的上游 403 仍按"上游拒绝"处理；未配置中继时直连默认地址', async () => {
  const { predictGraphql } = require('../api/_predict-graphql');
  await withEnv({ PREDICT_GRAPHQL_RELAY_URL: 'https://relay.example.app', PREDICT_GRAPHQL_RELAY_TOKEN: undefined }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => response({ status: 403, body: '{"message":"forbidden"}' });
    try {
      await assert.rejects(() => predictGraphql({ query: '{ x }' }), /Upstream rejected the session \(HTTP 403\)/);
    } finally { globalThis.fetch = realFetch; }
  });
  await withEnv({ PREDICT_GRAPHQL_RELAY_URL: undefined, PREDICT_GRAPHQL_URL: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let url = null;
    globalThis.fetch = async (u, init) => { url = String(u); assert.strictEqual(init.headers['x-relay-token'], undefined); return response({ body: '{"data":{}}' }); };
    try {
      await predictGraphql({ query: '{ x }' });
      assert.strictEqual(url, 'https://graphql.predict.fun/graphql');
    } finally { globalThis.fetch = realFetch; }
  });
});
