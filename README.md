# Decisão de Vendas com jev

Projeto para testar o modelo **jev** (defapi.org, versão `jev-1.13`) como motor de decisão: o usuário informa quanto cada vendedor vendeu e o jev responde **qual vendeu mais, com a probabilidade de cada um**.

Para avaliar o jev com honestidade, cada decisão é comparada com um **modelo de referência estatístico** (Monte Carlo). A tela mostra se os dois concordam no vencedor e o erro médio entre as probabilidades.

![Interface](docs/interface.png)

## Como rodar

Requisito: Node.js 18 ou superior. Não há dependências para instalar.

```bash
cp .env.example .env
```

Edite o `.env` e preencha `JEV_API_KEY` com a sua chave do defapi.org. Confira também `JEV_API_URL` (veja "Pendências").

```bash
npm start
```

Abra http://localhost:3000.

```bash
npm test
```

## Como funciona

| Camada | Arquivo | Papel |
| :-- | :-- | :-- |
| Interface | `public/index.html` | Formulário dos vendedores, resultado do jev, referência, avaliação e histórico |
| API | `server.js` | `POST /api/decidir`, `GET /api/status`, validação, log de auditoria |
| Adaptador jev | `src/jev.js` | Prompt, chamada HTTP e leitura da resposta. Único arquivo a mudar se o formato da API for outro |
| Referência | `src/baseline.js` | Simulação de Monte Carlo (20 mil rodadas, semente fixa) |

**Entrada:** um total por vendedor (`15000`) ou vários lançamentos separados por `;` (`1200; 980; 1430`), que são somados.

**O que pedimos ao jev:** um JSON `{"probabilidades": {...}, "vencedor": "...", "justificativa": "..."}`. O servidor normaliza as probabilidades (aceita 0 a 1 ou 0 a 100) e sinaliza quando o vencedor declarado não bate com a maior probabilidade.

**Modelo de referência:** com vários lançamentos, a incerteza do total vem da variação real dos valores. Com um único valor, usa `BASELINE_CV` (padrão 10%). Quanto mais próximos os totais, mais dividida fica a probabilidade.

## Como testar o modelo (roteiro sugerido)

1. **Caso óbvio:** 10000 / 50000 / 12000. Esperado: jev perto de 100% no maior.
2. **Empate técnico:** 10000 / 10200 / 9900. Esperado: probabilidades divididas.
3. **Volatilidade:** um vendedor estável (100; 101; 99) contra um volátil (10; 200; 5) com totais parecidos.
4. **Ruído de formato:** nomes com acento, valores com vírgula decimal, 5 ou mais vendedores.
5. **Consistência:** repetir o mesmo caso 5 vezes e ver se o jev muda a resposta.

Critério de aceite sugerido para o piloto: concordância no vencedor acima de 95% nos casos óbvios, zero respostas fora do formato JSON e latência média abaixo de 5 s.

## Governança e LGPD

- A chave do jev fica só no servidor (`.env`, fora do git). O navegador nunca a vê.
- Cada decisão é registrada em `logs/decisoes.jsonl` (entradas, resposta, latência) para auditoria.
- Nomes de vendedores são dados pessoais. Para testes, prefira apelidos ou códigos.
- A decisão do jev é apoio, não decisão final: mantenha revisão humana antes de qualquer efeito em comissão ou avaliação de desempenho.

## Pendências

- [ ] Confirmar na documentação do defapi.org o endpoint exato e o formato da requisição. O projeto assume o padrão chat completions compatível com OpenAI em `https://api.defapi.org/v1/chat/completions`, com `Authorization: Bearer`. Se for diferente, ajuste `JEV_API_URL` e, se preciso, `src/jev.js`.
- [ ] Rodar o roteiro de testes acima com a chave real e registrar os resultados.
