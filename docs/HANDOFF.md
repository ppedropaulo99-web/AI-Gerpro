# AI Gerpro — Guia de handoff para a equipe da Cognitiva (Etapa 4)

Este é o ponto de partida para a equipe que vai assumir o AI Gerpro. O guia resume o que existe, como executar e o
que falta para integrar o assistente ao Gerpro. Os detalhes técnicos estão em:

- [ARCHITECTURE.md](ARCHITECTURE.md): arquitetura, decisões, streaming, raciocínio e cancelamento.
- [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md): Qdrant, Neo4j, embeddings, mapeamento e autorização.
- [BENCHMARK-MODELOS.md](BENCHMARK-MODELOS.md): escolha do modelo local.

> **Estado da entrega:** ambiente de demonstração (`APP_ENV=demo`), **sem dados reais**. Os conectores para Qdrant
> e Neo4j estão implementados e testados com dublês, mas **nunca foram executados contra bancos reais**. Sem
> configuração, o assistente funciona só com o Ollama.

---

## 1. Implementado × não validado

### Implementado e validado neste ambiente

| Item | Como foi validado |
|---|---|
| Backend Fastify: `/api/health`, `/api/health/ollama`, `/api/chat`, `/api/chat/stream` (NDJSON) | Testes automatizados + smoke HTTP com Ollama real |
| Integração com Ollama local (modelo `qwen3:4b-instruct-2507-q4_K_M`), pré-carga, timeout, erros classificados | Testes + smoke real |
| Streaming e **cancelamento** (o backend aborta a geração no Ollama) | Testes + verificação manual com Ollama real |
| Filtro do raciocínio interno do modelo (nunca chega ao navegador) | Testes |
| Widget embutível (`ai-gerpro.js` + `ai-gerpro.css`), painel lateral, `conversationKey`, `resetConversation` | Testes de frontend + página hospedeira de exemplo |
| Renderização de Markdown segura (sem `innerHTML`) | Testes |
| Funcionamento **sem bases configuradas** (`grounding: "disabled"`) | Testes + smoke HTTP |
| Validação do corpo (só `messages`; campos como `filters` são recusados com 400) | Testes + smoke HTTP |
| Carregamento e validação do mapeamento (`retrieval.config.json`), `cypher-guard` | Testes |
| Autorização `none` e `jwt-hs256` (assinatura, `exp`, `iss`, `aud`, TTL máximo) | Testes |
| Orquestração da recuperação (paralelismo, prazos, falhas parciais, vínculos, citações, continuações) | Testes com dublês em memória + modelo real com trechos sintéticos |

### Implementado, mas **não validado com bancos reais**

| Item | Pendência |
|---|---|
| Conector Qdrant (`@qdrant/js-client-rest`, somente leitura) | Executar contra instância de teste ou homologação |
| Conector Neo4j (`neo4j-driver`, sessão `READ`) | Idem |
| Embeddings da pergunta via Ollama (`/api/embed`) | Depende do modelo real usado na indexação |
| Filtros de organização e permissão nas bases | Conferir com dados de teste de duas organizações |
| Testes de integração (`test-integration/`) | Prontos e compilando; ignorados sem as variáveis (não há Qdrant/Neo4j/Docker neste ambiente) |
| Qualidade das respostas com dados reais | Avaliar em homologação |

---

## 2. Arquitetura em uma página

```
Página do Gerpro (qualquer HTML)
  └─ <script src="ai-gerpro.js">  →  AIGerpro.mount({...})  →  botão + painel lateral (React, CSS prefixado .gia-)
        │ fetch /api  (NDJSON em streaming; Authorization: Bearer <token do Gerpro>, opcional)
        ▼
Backend AI Gerpro (Node.js 24+, Fastify, TypeScript)
  ├─ OllamaClient ─────────────► Ollama local (chat e embeddings)
  ├─ AuthContextResolver ─────── identidade/organização/permissões vindas do Gerpro (padrão: none)
  └─ RetrievalService (opcional, somente leitura)
       ├─ QdrantVectorStore ───► Qdrant  (filtro de organização/permissão aplicado no servidor)
       └─ Neo4jGraphStore ─────► Neo4j   (só consultas Cypher pré-autorizadas no mapeamento)
```

- O navegador **nunca** fala com Ollama, Qdrant ou Neo4j. Endereços e credenciais ficam só no `backend/.env`.
- Sem recuperação configurada, o fluxo é apenas widget → backend → Ollama.
- Configuração: variáveis em `backend/.env` (modelo: `.env.example`) e mapeamento das bases em
  `backend/retrieval.config.json` (modelo: `backend/retrieval.config.example.json`). **Nenhum dos dois arquivos
  reais é versionado.**

Estrutura:

```
.env.example                      modelo de configuração (sem segredos)
package.json                      monorepo (npm workspaces): scripts de build, testes e execução
backend/
  src/server.ts, app.ts           entrada e montagem do Fastify
  src/config/env.ts               configuração tipada e validada
  src/routes/                     chat e health
  src/contracts/api.ts            contrato HTTP público (espelhado em frontend/src/api/types.ts)
  src/ollama/                     cliente Ollama, filtro de raciocínio, prompt do sistema
  src/adapters/                   Qdrant, Neo4j, cypher-guard (somente leitura)
  src/embeddings/                 provedor de embeddings (Ollama)
  src/auth/                       AuthContext e resolvedores (none, jwt-hs256)
  src/retrieval/                  mapeamento, orquestração, contexto, continuações
  scripts/                        smoke, benchmarks, diagnóstico da recuperação
  test/                           testes automatizados (sem rede)
  test-integration/               testes opcionais contra serviços de teste
  retrieval.config.example.json   modelo de mapeamento (marcadores SUBSTITUIR_)
frontend/
  src/components/                 ChatPanel, ChatLauncher, Markdown, SourceList
  src/embed.tsx                   API do widget (mountAiGerpro / AIGerpro.mount)
  src/api/                        cliente HTTP e tipos
  index.html, pagina.html         página hospedeira de exemplo e chat em página inteira
  vite.widget.config.ts           build IIFE do widget
docs/                             documentação
```

---

## 3. Instalar em outro computador

Requisitos: **Node.js ≥ 24** com npm, **Git** e **Ollama** com o modelo padrão.

```powershell
git clone <URL-do-repositorio-privado> "C:\IA Gerpro"
cd "C:\IA Gerpro"
npm ci                                   # instala exatamente as versões do package-lock.json
ollama pull qwen3:4b-instruct-2507-q4_K_M
Copy-Item .env.example backend\.env      # opcional; sem ele valem os padrões (somente Ollama)
npm run typecheck; npm test              # confere a instalação
```

Os arquivos gerados (`node_modules/`, `backend/dist/`, `frontend/dist/`, `frontend/dist-widget/`) não estão no
repositório: são recriados por `npm ci` e `npm run build`.

## 4. Executar frontend e backend

Desenvolvimento (dois terminais):

```powershell
npm run dev:backend    # http://127.0.0.1:3001 (API; pré-carrega o modelo)
npm run dev:frontend   # http://127.0.0.1:5173 (Vite; /api é repassado ao backend)
```

- http://127.0.0.1:5173/ — página hospedeira de exemplo com o botão no canto inferior esquerdo.
- http://127.0.0.1:5173/pagina.html — chat em página inteira.

Produção:

```powershell
npm run build                 # backend/dist, frontend/dist e frontend/dist-widget
npm start -w backend          # lê backend/.env; usa backend/dist/server.js
```

Verificação rápida: `GET http://127.0.0.1:3001/api/health` (estado, ambiente e adaptadores, sem segredos) e
`GET /api/health/ollama` (200 = modelo disponível).

## 5. Incorporar o widget em uma página do Gerpro

1. `npm run build:widget` gera `frontend/dist-widget/ai-gerpro.js` e `ai-gerpro.css`. Publique os dois junto
   com a página (ou em um CDN interno). O Gerpro **não precisa usar React**.
2. Na página:

   ```html
   <link rel="stylesheet" href="/assets/ai-gerpro/ai-gerpro.css" />
   <script src="/assets/ai-gerpro/ai-gerpro.js"></script>
   <script>
     const ai = AIGerpro.mount({
       apiBaseUrl: "https://ai-gerpro.seu-dominio/api",
       // Opcional (consultas às bases): token curto emitido pelo backend do Gerpro, pedido a cada mensagem.
       getAuthToken: async () => (await fetch("/gerpro/api/ai-token", { credentials: "include" })).text(),
       // Opcional: separa conversas por usuário e organização.
       conversationKey: `${usuarioId}:${organizacaoId}`,
       // showLauncher: false,   // para usar um botão próprio do Gerpro com ai.toggle()
       // position, title, streaming, defaultOpen, container, onOpenChange
     });
   </script>
   ```

3. API do objeto retornado: `open()`, `close()`, `toggle()`, `isOpen()`, `resetConversation()`,
   `setConversationKey(chave)`, `unmount()`.
4. Se a página for servida por outra origem, defina `CORS_ORIGIN` no `backend/.env` com essa origem.
5. O CSS usa o prefixo `.gia-` para evitar colisões. O isolamento por Shadow DOM continua pendente.

## 6. Configurar Qdrant, Neo4j e embeddings

Tudo é opcional e fica no `backend/.env`. O passo a passo completo está em
[INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 2 a 5.

| Base | Variáveis | Regras |
|---|---|---|
| Qdrant | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_TIMEOUT_MS` | HTTPS fora de localhost; credencial **somente leitura**; nunca cria nem altera coleções |
| Neo4j | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `NEO4J_TIMEOUT_MS` | `bolt+s://`/`neo4j+s://` fora de localhost; usuário com papel **somente leitura**; sessão `READ` |
| Embeddings | `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIMENSIONS`, `EMBEDDINGS_QUERY_PREFIX`, `EMBEDDINGS_BASE_URL` | Deve ser **o mesmo modelo usado na indexação** das coleções; não há valor padrão |
| Mapeamento | `RETRIEVAL_CONFIG_PATH=retrieval.config.json` | Arquivo sem segredos, **fora do Git** |

Para informar o modelo de embeddings: instale-o no Ollama (`ollama pull <modelo>`), defina `EMBEDDINGS_MODEL` com o
nome exato, `EMBEDDINGS_DIMENSIONS` com a dimensão do vetor das coleções e, se o modelo exigir, o prefixo de
consulta (ex.: `query: `). O `/api/health` avisa se a dimensão do modelo não coincidir com a das coleções.

## 7. Mapear coleções, campos e consultas Cypher

```powershell
Copy-Item backend\retrieval.config.example.json backend\retrieval.config.json
```

Troque **todos** os marcadores `SUBSTITUIR_` pelos nomes reais. O carregador recusa campos desconhecidos.

- **Coleções do Qdrant** (`qdrant.collections[]`): `name`, `contentField`, `titleField`, `urlField`,
  `identifierFields`, `organizationField` (obrigatório, exceto `public: true`), `permissionsField`,
  `requiredPermission`, `limit`, `scoreThreshold`.
- **Consultas Neo4j** (`neo4j.queries[]`): somente leitura, com `RETURN` e `LIMIT $limit`, filtrando por
  `$auth_organizationId`. Parâmetros declarados com tipo e `pattern`. `fromQuestion` (regex com um grupo; em JSON,
  `\\b` e `\\d`) aciona a consulta quando a pergunta contém o identificador; `triggerTerms` restringe a consulta a
  perguntas que mencionam o assunto.
- **Vínculos** (`neo4j.links[]`): ligam um campo do payload do Qdrant ao parâmetro de uma consulta do grafo. Nenhuma
  relação é presumida.

Tabelas completas: [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 4 e 5. Após mapear, rode
`npm run check:retrieval -w backend`.

## 8. Autenticação, permissões e `conversationKey`

- O padrão é `GERPRO_AUTH_MODE=none`: mesmo com as bases configuradas, **nada é consultado** até a autenticação
  ser integrada.
- **Opção A (`jwt-hs256`, implementação de referência):** o backend do Gerpro emite um JWT HS256 curto (≤ 15 min)
  com `sub` (usuário), `org` (organização) e `perms` (lista de permissões), assinado com `GERPRO_AUTH_JWT_SECRET`
  (≥ 32 bytes, compartilhado só entre os dois backends). O widget pede o token via `getAuthToken` a cada mensagem e
  o envia em `Authorization: Bearer`.
- **Opção B:** implementar um `AuthContextResolver` próprio em `backend/src/auth/` (OIDC/JWKS, sessão
  compartilhada, proxy reverso).
- O navegador **não** envia filtros nem identidade: o corpo aceita só `messages`. Token inválido → HTTP 401.
- Os valores de `org` e `perms` precisam coincidir com os gravados em `organizationField`, `permissionsField`,
  `requiredPermission` e `$auth_organizationId`.
- **`conversationKey`:** informe `usuario:organizacao` no `mount` e chame `ai.setConversationKey(...)` ao trocar de
  usuário ou organização e `ai.resetConversation()` no logout. Assim o histórico de uma sessão não passa para outra.

Detalhes: [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 6 e 7A.

## 9. Testes

| Comando | O que valida | Requer |
|---|---|---|
| `npm run typecheck` | Tipos do backend e do frontend | — |
| `npm test` | 126 testes do backend + 38 do frontend, com dublês e sem rede | — |
| `npm run build` | Compilação do backend, das páginas e do widget | — |
| `npm audit` | Vulnerabilidades conhecidas nas dependências | Internet |
| `npm run smoke` | Pergunta real ao Ollama | Ollama + modelo |
| `npm run check:retrieval -w backend` | Conectividade e configuração de Qdrant, Neo4j, embeddings e mapeamento (sem segredos) | Bases configuradas |
| `npm run test:integration -w backend` | Testes **somente leitura** contra as bases configuradas | `INTEGRATION_RETRIEVAL=true` + bases de teste |
| idem, com `IT_QDRANT_URL` / `IT_NEO4J_*` | Testes que **criam e removem** dados técnicos descartáveis | Instâncias **isoladas** (só localhost, salvo `IT_ALLOW_REMOTE=true`) |

```powershell
$env:INTEGRATION_RETRIEVAL="true"; npm run test:integration -w backend
```

Use **somente serviços de teste autorizados**. Veja [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md),
seções 10 e 10A.

## 10. Avisos exibidos no widget

| Situação | Aviso no topo do painel |
|---|---|
| Recuperação desabilitada (padrão) | "O assistente **não tem acesso** a processos, contratos ou dados do Gerpro. As respostas são geradas por um modelo de IA local e podem conter erros." |
| Recuperação habilitada (a partir da 1ª resposta com `grounding` diferente de `disabled`) | "As respostas podem utilizar informações recuperadas das bases integradas ao Gerpro. Confira as fontes indicadas." |

## 11. Atividades que dependem da Cognitiva

1. Disponibilizar instâncias de **teste ou homologação** do Qdrant e do Neo4j (o ambiente desta entrega não tem
   Docker, Java, Qdrant nem Neo4j).
2. Informar os nomes reais das coleções, campos de payload, rótulos e propriedades do grafo.
3. Informar o **modelo de embeddings** e a dimensão usados na indexação; instalá-lo no Ollama do servidor.
4. Escrever e revisar as consultas Cypher autorizadas, os vínculos entre as bases e as regex `fromQuestion` /
   `triggerTerms` dos identificadores reais (processo, contrato etc.).
5. Criar credenciais **somente leitura** (API key do Qdrant e usuário do Neo4j) e índices de payload no Qdrant.
6. Implementar no backend do Gerpro a emissão do token (Opção A) ou um resolvedor próprio (Opção B) e definir os
   nomes das permissões.
7. Integrar `conversationKey` / `setConversationKey` / `resetConversation` ao login, à troca de organização e ao
   logout do Gerpro.
8. Definir a hospedagem do backend (rede interna, TLS, `CORS_ORIGIN`) e do widget, e o cofre de segredos.
9. Rodar `check:retrieval` e `test:integration` (incluindo os da seção 10A) contra as instâncias de teste.
10. Avaliar a qualidade com perguntas reais em homologação e ajustar `limit`, `scoreThreshold`,
    `RETRIEVAL_CONTEXT_TURNS` e os orçamentos de contexto.
11. Concluir o checklist de segurança ([INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seção 11).

## 12. Versionamento e segredos

O `.gitignore` exclui: `.env` e variantes (exceto `.env.example`), `backend/retrieval.config.json` e outras
variantes reais do mapeamento (exceto o modelo), certificados e chaves (`*.pem`, `*.key`, `*.pfx`…), logs,
temporários, `bench-results/` (respostas do modelo e dados do ambiente), builds e `node_modules/`.

Regras para a equipe:

- Nunca faça commit de `backend/.env`, `backend/retrieval.config.json`, tokens, dumps ou dados de clientes.
- Antes de cada push, confira `git status` e `git diff --cached`.
- O único segredo presente no repositório é `TEST_SECRET` em `backend/test/helpers/retrieval-fakes.ts`, um valor
  fictício usado só pelos testes. Não o reutilize em nenhum ambiente.
