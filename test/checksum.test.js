// keccak256 / EIP-55 校验和地址 单元测试。
// 运行：npm test （即 node --test test/）

const test = require('node:test');
const assert = require('node:assert');

const { keccak256, toChecksumAddress } = require('../api/_predict-graphql');

// keccak256 输入为字节数组，输出 64 位十六进制字符串。
test('keccak256: empty input', () => {
  assert.strictEqual(
    keccak256([]),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
});

test('keccak256: "abc"', () => {
  assert.strictEqual(
    keccak256([...new TextEncoder().encode('abc')]),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
  );
});

// EIP-55 官方测试向量（https://eips.ethereum.org/EIPS/eip-55）
const EIP55_VECTORS = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  // 全大写 / 全小写边界用例
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  '0xde709f2102306220921060314715629080e2fb77',
  '0x27b1fdb04752bbc536007a920d24acb045561c26',
];

for (const expected of EIP55_VECTORS) {
  test(`toChecksumAddress: ${expected}`, () => {
    assert.strictEqual(toChecksumAddress(expected.toLowerCase()), expected);
  });
}
