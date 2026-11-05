# Decisão de Vendas com jev

Aplicação para testar o modelo **jev** (defapi.org, `jev-1.13`) como motor de decisão: o usuário informa quanto cada vendedor vendeu e o modelo escolhido responde **qual vendeu mais, com a probabilidade de cada um**. Cada decisão é comparada com um **modelo de referência estatístico** (Monte Carlo) para avaliar se o jev acerta.

![Interface](docs/interface.png)

## Arquitetura

```
Navegador (GitHub Pages)  ──►  Supabase Edge Function "jev-decisao"  ──►  jev (defapi.org)
  public/                         guarda a JEV_API_KEY                    
  referência calculada aqui       valida, limita uso, registra auditoria  
                                  tabela jev_decisoes (RLS fechado)       
```

| Peça | Onde | Papel |
| :-- | :-- | :-- |
| Front-end | `public/` publicado no GitHub Pages | Formulário, seletor de modelo, resultados, avaliação e histórico |
| Lógica compartilhada | `public/js/core.js`, `public/js/jev.js` | Validação, modelo de referência, prompt e leitura da resposta do jev |
| Backend | `supabase/functions/jev-decisao` | Chama o jev com a chave guardada nos secrets, limita uso por origem, grava auditoria |
| Banco | `supabase/migrations` | Tabela `jev_decisoes` com RLS ativo e sem acesso público |
| Deploy | `.github/workflows/pages.yml` | Roda os testes e publica `public/` no Pages a cada push |

**Modelo como escolha:** o seletor "Modelo de decisão" lista os modelos liberados no secret `JEV_MODELOS` (padrão `jev-1.13`). Para comparar outro modelo do defapi.org, basta incluir o nome no secret, por exemplo `jev-1.13,outro-modelo`.

**Dois modos de conexão** (card "Conexão com o jev"):
- **Supabase (recomendado):** a chave nunca chega ao navegador.
- **Direto do navegador:** para testes rápidos com sua própria chave. Só funciona se a API do defapi.org aceitar chamadas do navegador (CORS).

## Status do deploy

- [x] Tabela `jev_decisoes` criada no projeto Supabase **ClaudeProjects** (`xtrvojnauvkkterogrst`, São Paulo)
- [x] Edge Function `jev-decisao` publicada
- [ ] Cadastrar a chave do jev nos secrets do Supabase
- [ ] Ativar o GitHub Pages

## Passo a passo para colocar no ar

**1. Cadastrar a chave do jev no Supabase**

No painel do Supabase: Edge Functions, Secrets. Crie:

| Secret | Valor |
| :-- | :-- |
| `JEV_API_KEY` | sua chave do defapi.org |
| `JEV_API_URL` | opcional. Padrão `https://api.defapi.org/v1/chat/completions` (confirmar na documentação do defapi.org) |
| `JEV_MODELOS` | opcional. Padrão `jev-1.13` |
| `ALLOWED_ORIGINS` | opcional. Padrão `https://rodrigosilvacio.github.io,http://localhost:3000` |
| `LIMITE_POR_HORA` | opcional. Padrão `60` decisões por hora por origem |

Ou pelo terminal:

```bash
supabase secrets set JEV_API_KEY=sua-chave --project-ref xtrvojnauvkkterogrst
```

**2. Ativar o GitHub Pages**

No repositório: Settings, Pages, em "Build and deployment" escolha **Source: GitHub Actions**. Depois rode o workflow "Deploy GitHub Pages" em Actions (ou faça um push). O site fica em:

https://rodrigosilvacio.github.io/claude-jev/

Observação: GitHub Pages em repositório privado exige plano pago. Se o repositório for privado no plano gratuito, torne-o público.

## Desenvolvimento local

Requisito: Node.js 18 ou superior, sem dependências.

```bash
npm start
```

```bash
npm test
```

Se alterar `public/js/core.js` ou `public/js/jev.js`, sincronize a cópia da Edge Function (um teste falha se as duas divergirem):

```bash
npm run sync:supabase
```

```bash
supabase functions deploy jev-decisao --project-ref xtrvojnauvkkterogrst
```

## Como testar o modelo (roteiro sugerido)

1. **Caso óbvio:** 10000 / 50000 / 12000. Esperado: jev perto de 100% no maior.
2. **Empate técnico:** 10000 / 10200 / 9900. Esperado: probabilidades divididas.
3. **Volatilidade:** um vendedor estável (100; 101; 99) contra um volátil (10; 200; 5) com totais parecidos.
4. **Ruído de formato:** nomes com acento, valores com vírgula decimal, 5 ou mais vendedores.
5. **Consistência:** repetir o mesmo caso 5 vezes e ver se o jev muda a resposta.

Critério de aceite sugerido para o piloto: concordância no vencedor acima de 95% nos casos óbvios, zero respostas fora do formato JSON e latência média abaixo de 5 s. O histórico pode ser exportado em JSON pela tela, e a auditoria completa fica na tabela `jev_decisoes`.

## Governança e LGPD

- A chave do jev fica nos secrets do Supabase. O `public/js/config.js` contém apenas a URL e a chave anon do Supabase, que são públicas por design.
- A tabela `jev_decisoes` tem RLS ativo sem políticas: só a Edge Function (service role) grava e lê.
- O IP de quem usa não é salvo: guardamos apenas um hash truncado para aplicar o limite por hora.
- Nomes de vendedores são dados pessoais. Para testes, prefira apelidos ou códigos.
- A decisão do jev é apoio, não decisão final: mantenha revisão humana antes de qualquer efeito em comissão ou avaliação de desempenho.
- Limite conhecido do MVP: a chave anon é pública, então qualquer pessoa com o link pode consumir até `LIMITE_POR_HORA` chamadas por origem. Para produção, adicionar login (Supabase Auth) antes de liberar.

## Pendências

- [ ] Confirmar na documentação do defapi.org o endpoint exato e o formato da requisição do jev. O projeto assume o padrão chat completions compatível com OpenAI, com `Authorization: Bearer`. Se for diferente, ajuste `public/js/jev.js` e rode `npm run sync:supabase`.
- [ ] Rodar o roteiro de testes com a chave real e registrar os resultados.
