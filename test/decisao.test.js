'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { baselineProbabilities } = require('../src/baseline');
const { parseJevResponse, callJev } = require('../src/jev');
const { validar } = require('../server');

test('baseline: diferença grande dá quase 100% ao maior', () => {
  const r = baselineProbabilities([
    { nome: 'A', vendas: [10000] },
    { nome: 'B', vendas: [50000] },
    { nome: 'C', vendas: [12000] },
  ]);
  assert.strictEqual(r.vencedor, 'B');
  assert.ok(r.probabilidades.B > 0.99);
  const soma = Object.values(r.probabilidades).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(soma - 1) < 1e-9);
});

test('baseline: valores próximos geram incerteza', () => {
  const r = baselineProbabilities([
    { nome: 'A', vendas: [10000] },
    { nome: 'B', vendas: [10200] },
  ]);
  assert.strictEqual(r.vencedor, 'B');
  assert.ok(r.probabilidades.B > 0.5 && r.probabilidades.B < 0.7);
});

test('baseline: lista de lançamentos usa a variação real', () => {
  const r = baselineProbabilities([
    { nome: 'Estável', vendas: [100, 101, 99, 100] },
    { nome: 'Volátil', vendas: [10, 200, 5, 190] },
  ]);
  assert.ok(r.probabilidades['Volátil'] > 0.3 && r.probabilidades['Volátil'] < 0.7);
});

test('parse: chat completions com JSON em percentuais e nome em caixa diferente', () => {
  const r = parseJevResponse(
    {
      choices: [
        {
          message: {
            content:
              'Resultado:\n```json\n{"probabilidades":{"ana":70,"Bruno":20,"Carla":10},"vencedor":"Ana","justificativa":"Maior total."}\n```',
          },
        },
      ],
    },
    ['Ana', 'Bruno', 'Carla']
  );
  assert.strictEqual(r.vencedor, 'Ana');
  assert.ok(Math.abs(r.probabilidades.Ana - 0.7) < 1e-9);
  assert.strictEqual(r.coerente, true);
  assert.strictEqual(r.justificativa, 'Maior total.');
});

test('parse: detecta incoerência entre vencedor declarado e probabilidades', () => {
  const r = parseJevResponse(
    { choices: [{ message: { content: '{"probabilidades":{"A":0.2,"B":0.8},"vencedor":"A"}' } }] },
    ['A', 'B']
  );
  assert.strictEqual(r.vencedor, 'B');
  assert.strictEqual(r.coerente, false);
});

test('parse: resposta sem JSON gera erro claro', () => {
  assert.throws(
    () => parseJevResponse({ choices: [{ message: { content: 'Não sei.' } }] }, ['A', 'B']),
    /JSON de probabilidades/
  );
});

test('validar: rejeita negativos, nomes repetidos e menos de 2 vendedores', () => {
  assert.ok(validar({ vendedores: [{ nome: 'A', vendas: [1] }] }).erro);
  assert.ok(validar({ vendedores: [{ nome: 'A', vendas: [1] }, { nome: 'a', vendas: [2] }] }).erro);
  assert.ok(validar({ vendedores: [{ nome: 'A', vendas: [-1] }, { nome: 'B', vendas: [2] }] }).erro);
  assert.deepStrictEqual(
    validar({ vendedores: [{ nome: ' A ', vendas: 5 }, { nome: '', vendas: [1, 2] }] }).vendedores,
    [{ nome: 'A', vendas: [5] }, { nome: 'Vendedor 2', vendas: [1, 2] }]
  );
});

test('callJev: envia formato chat completions com Bearer e modelo (servidor local de contrato)', async () => {
  let recebido;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      recebido = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"probabilidades":{"A":0.1,"B":0.9},"vencedor":"B"}' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`;
  try {
    const r = await callJev(
      [{ nome: 'A', vendas: [1] }, { nome: 'B', vendas: [9] }],
      { apiKey: 'k', url, model: 'jev-1.13', timeoutMs: 5000 }
    );
    assert.strictEqual(r.vencedor, 'B');
    assert.strictEqual(recebido.auth, 'Bearer k');
    assert.strictEqual(recebido.body.model, 'jev-1.13');
    assert.strictEqual(recebido.body.messages.length, 2);
  } finally {
    srv.close();
  }
});

test('callJev: sem chave retorna NAO_CONFIGURADO', async () => {
  await assert.rejects(() => callJev([], { apiKey: '' }), (e) => e.code === 'NAO_CONFIGURADO');
});
