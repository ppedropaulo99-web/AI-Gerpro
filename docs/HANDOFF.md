# AI Gerpro — Guia de handoff para a equipe da Cognitiva (Etapas 4 e 4.1)

Este é o ponto de partida para a equipe que vai assumir o AI Gerpro. O guia resume o que existe, como executar,
como implantar e o que falta para integrar o assistente ao Gerpro. Os detalhes técnicos estão em:

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
| Backend Fastify: `/api/chat`, `/api/chat/stream` (NDJSON), health público e diagnóstico interno | Testes automatizados + execução real com Ollama |
| Integração com Ollama local (modelo `qwen3:4b-instruct-2507-q4_K_M`), pré-carga, timeout, erros classificados | Testes + smoke real |
| Streaming e **cancelamento** (o backend aborta a geração no Ollama) | Testes + navegador com Ollama real |
| Filtro do raciocínio interno do modelo (nunca chega ao navegador) | Testes |
| Widget embutível em **Shadow DOM** (arquivo único `ai-gerpro.js`), instância única, `conversationKey`, `resetConversation` | Testes em navegador (Edge headless) numa página HTML sem React com CSS global agressivo: estilos idênticos aos da página de referência |
| Histórico recortado aos limites do backend (40 perguntas seguidas sem erro; conversa visível completa) | Testes unitários + 40 perguntas reais no navegador |
| Teclado, foco e acessibilidade do painel (Enter, Esc, foco ao abrir/fechar e após cada resposta, `aria-*`, `inert`) | Testes em navegador |
| Funcionamento **sem bases configuradas** (`grounding: "disabled"`) | Testes + execução real |
| Autenticação do chat (`CHAT_REQUIRE_AUTH`), JWT HS256 (assinatura, `exp`, `iss`, `aud`, TTL máximo) | Testes + navegador com backend protegido |
| Modo corporativo: configurações inseguras recusadas na inicialização | Testes + inicialização real do processo |
| Diagnóstico interno protegido (token ou loopback sem proxy); health público sem detalhes de infraestrutura | Testes + chamadas reais (direta e via proxy) |
| Erros enviados ao navegador sem URLs, portas, servidores ou corpo do upstream | Testes (inclusive com o cliente Ollama real apontando para um host inacessível) |
| Carregamento e validação do mapeamento (`retrieval.config.json`), `cypher-guard` | Testes |
| Orquestração da recuperação (paralelismo, prazos, falhas parciais, vínculos, citações, continuações) | Testes com dublês em memória + modelo real com trechos sintéticos |

### Implementado, mas **não validado com bancos reais**

| Item | Pendência |
|---|---|
| Conector Qdrant (`@qdrant/js-client-rest`, somente leitura) | Executar contra instância de teste ou homologação |
| Conector Neo4j (`neo4j-driver`, sessão `READ`) | Idem |
| Embeddings da pergunta via Ollama (`/api/embed`) | Depende do modelo real usado na indexação |
| Filtros de organização e permissão nas bases | Conferir com dados de teste de duas organizações. **Atenção ao tipo:** o filtro compara o id da organização como **texto**; se o campo estiver gravado como número, a busca volta vazia sem erro |
| Recuperação contextual com o histórico recortado | Validada com dublês; repetir com dados reais |
| Testes de integração (`test-integration/`) | Prontos e compilando; ignorados sem as variáveis (não há Qdrant/Neo4j/Docker neste ambiente) |
| Qualidade das respostas com dados reais | Avaliar em homologação |
| Proxy reverso, limite de requisições e CSP do Gerpro | Configurações de referência na seção 4; não testadas (não há proxy neste ambiente) |

---

## 2. Arquitetura em uma página

```
Página do Gerpro (qualquer HTML, sem React)
  └─ <script src="ai-gerpro.js">  →  AIGerpro.mount({...})
        └─ <ai-gerpro-widget> com Shadow DOM: botão + painel lateral (React e CSS embutidos, isolados da página)
        │ fetch /api  (NDJSON em streaming; Authorization: Bearer <token do Gerpro>)
        ▼
Proxy reverso do Gerpro (TLS, rotas permitidas, limite de requisições, sem buffering no stream)
        ▼
Backend AI Gerpro (Node.js 24+, Fastify, TypeScript)
  ├─ AuthContextResolver ─────── identidade/organização/permissões vindas do Gerpro (CHAT_REQUIRE_AUTH)
  ├─ OllamaClient ─────────────► Ollama local (chat e embeddings)
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
  src/config/env.ts               configuração tipada e validada (inclui o modo corporativo)
  src/routes/                     chat e health (público + diagnóstico interno)
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
  src/components/                 ChatPanel, ChatLauncher, Markdown, SourceList (+ CSS)
  src/embed.tsx                   API do widget (AIGerpro.mount) e Shadow DOM
  src/api/                        cliente HTTP, tipos e recorte do histórico (history.ts)
  index.html, pagina.html         página hospedeira de exemplo e chat em página inteira
  vite.widget.config.ts           build IIFE do widget (arquivo único)
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
Copy-Item .env.example backend\.env      # opcional; sem ele valem os padrões (somente Ollama, modo demo)
npm run typecheck; npm test              # confere a instalação
```

Os arquivos gerados (`node_modules/`, `backend/dist/`, `frontend/dist/`, `frontend/dist-widget/`) não estão no
repositório: são recriados por `npm ci` e `npm run build`.

Desenvolvimento (dois terminais):

```powershell
npm run dev:backend    # http://127.0.0.1:3001 (API; pré-carrega o modelo)
npm run dev:frontend   # http://127.0.0.1:5173 (Vite; /api é repassado ao backend)
```

- http://127.0.0.1:5173/ — página hospedeira de exemplo com o botão no canto inferior esquerdo.
- http://127.0.0.1:5173/pagina.html — chat em página inteira.

---

## 4. Implantação (homologação e produção)

### 4.1 Modo corporativo (`APP_ENV`)

Qualquer `APP_ENV` **fora** de `demo`, `dev`, `development`, `local` e `test` (ex.: `homologacao`, `producao`)
ativa o modo corporativo. O backend **recusa iniciar** (mensagem clara, sem ecoar segredos) se:

| Regra | Variáveis |
|---|---|
| O chat não pode ser anônimo (nada chega à GPU sem autenticação) | `CHAT_REQUIRE_AUTH` (padrão `true`; `false` é recusado) + `GERPRO_AUTH_MODE=jwt-hs256` ou resolvedor próprio |
| JWT com emissor e audiência | `GERPRO_AUTH_JWT_ISSUER`, `GERPRO_AUTH_JWT_AUDIENCE` |
| TLS verificado no Neo4j | `NEO4J_URI` com `bolt+s://`/`neo4j+s://` (sem `+ssc`); `NEO4J_ALLOW_INSECURE=true` recusado |
| Sem exceção de TLS no Qdrant | `QDRANT_ALLOW_INSECURE=true` recusado |
| Diagnóstico interno só com token | `DIAGNOSTICS_ALLOW_LOOPBACK` passa a `false`; `DIAGNOSTICS_TOKEN` ≥ 32 bytes, diferente do segredo JWT |

Exemplo mínimo de `backend/.env` de homologação:

```ini
APP_ENV=homologacao
HOST=127.0.0.1
PORT=3001
LOG_LEVEL=info
CORS_ORIGIN=https://gerpro-homolog.seu-dominio
GERPRO_AUTH_MODE=jwt-hs256
GERPRO_AUTH_JWT_SECRET=<cofre de segredos, >= 32 bytes>
GERPRO_AUTH_JWT_ISSUER=gerpro
GERPRO_AUTH_JWT_AUDIENCE=ai-gerpro
DIAGNOSTICS_TOKEN=<cofre de segredos, >= 32 bytes, diferente do JWT>
# + QDRANT_*, NEO4J_*, EMBEDDINGS_*, RETRIEVAL_CONFIG_PATH (seções 7 e 8)
```

A linha `Segurança: modo corporativo (estrito) | chat exige autenticação: sim | diagnóstico: token` no log de
inicialização confirma o modo ativo (só indicadores; nunca valores).

### 4.2 Diretório de trabalho

O backend **deve rodar com o diretório de trabalho em `backend/`**:

- `--env-file-if-exists=.env` (scripts `start`/`dev`) lê o `.env` do diretório atual;
- um `RETRIEVAL_CONFIG_PATH` relativo é resolvido a partir do diretório atual. Em produção, prefira um **caminho
  absoluto** (ex.: `/etc/ai-gerpro/retrieval.config.json` ou `D:\ai-gerpro\config\retrieval.config.json`).

`npm start -w backend` (na raiz) já usa `backend/` como diretório de trabalho. Com um supervisor, configure-o
explicitamente (seção 4.6). Sem o `.env`, o backend sobe com os padrões de demonstração, o que em produção é um
erro: confira a linha `Ambiente:` no log.

### 4.3 `HOST`, porta e `LOG_LEVEL`

- `HOST=127.0.0.1` (padrão): o backend só aceita conexões da própria máquina. É o recomendado com o proxy reverso no
  mesmo servidor.
- Proxy em outra máquina: use o IP interno (ou `0.0.0.0`) **e** restrinja a porta no firewall ao proxy. O backend
  nunca deve ficar acessível diretamente pela rede dos usuários.
- `LOG_LEVEL`: `info` (padrão) em produção; `debug` só para investigação. Os logs são JSON (Fastify/pino) e nunca
  incluem perguntas, trechos recuperados, tokens ou senhas; `Authorization` e `Cookie` são mascarados. O endereço
  interno do Ollama aparece só no log, nunca nas respostas.

### 4.4 Proxy reverso e streaming NDJSON

O widget recebe a resposta em **NDJSON** (`application/x-ndjson`, um evento por linha). O proxy **não pode
bufferizar nem comprimir** esse stream, senão o texto só aparece no fim. O backend já envia
`X-Accel-Buffering: no` e `Cache-Control: no-cache, no-transform`.

Exponha **somente** as rotas usadas pelo widget e bloqueie o diagnóstico na borda. Referência para **nginx**:

```nginx
# Limites por cliente (ver 4.5)
limit_req_zone  $binary_remote_addr zone=ai_chat:10m rate=20r/m;
limit_conn_zone $binary_remote_addr zone=ai_conn:10m;

upstream ai_gerpro { server 127.0.0.1:3001; keepalive 16; }

server {
  # ... TLS do Gerpro ...

  location = /ai-gerpro/api/chat/stream {
    limit_req  zone=ai_chat burst=5 nodelay;
    limit_conn ai_conn 2;
    proxy_pass http://ai_gerpro/api/chat/stream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;          # essencial para o streaming
    proxy_cache off;
    gzip off;
    proxy_read_timeout 180s;      # > OLLAMA_TIMEOUT_MS
  }
  location = /ai-gerpro/api/chat {
    limit_req  zone=ai_chat burst=5 nodelay;
    proxy_pass http://ai_gerpro/api/chat;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 180s;
  }
  location ~ ^/ai-gerpro/api/health(/ollama)?$ {
    proxy_pass http://ai_gerpro/api/health$1;
  }
  location /ai-gerpro/api/ { return 404; }   # inclui /api/health/details

  # Resposta 429 no formato que o widget entende
  limit_req_status 429; limit_conn_status 429;
  error_page 429 = @ai_rate_limited;
  location @ai_rate_limited {
    default_type application/json;
    return 429 '{"error":{"code":"rate_limited","message":"Muitas solicitações ao assistente. Aguarde alguns instantes."}}';
  }
}
```

No widget: `AIGerpro.mount({ apiBaseUrl: "/ai-gerpro/api", ... })`.

**IIS + ARR** (se o Gerpro usar IIS): na regra de proxy, defina `responseBufferLimit="0"` para a rota do stream,
desative a compressão dinâmica para `application/x-ndjson`, aumente o timeout do proxy para mais que
`OLLAMA_TIMEOUT_MS` e use regras de URL Rewrite para expor só as rotas acima.

**Diagnóstico atrás do proxy:** o modo loopback do `/api/health/details` recusa requisições com `X-Forwarded-For`,
`Forwarded` ou `X-Real-IP`, para que um proxy na mesma máquina não o torne público. Mesmo assim, bloqueie a rota na
borda (como acima) e use `DIAGNOSTICS_TOKEN` a partir da rede interna:

```powershell
curl.exe -H "Authorization: Bearer <DIAGNOSTICS_TOKEN>" http://127.0.0.1:3001/api/health/details
```

### 4.5 Limite de requisições (rate limiting)

O backend **não** implementa limite próprio: ele deve ficar no proxy, que vê todos os clientes. Recomendações:

- **Por cliente:** `limit_req` (ex.: 20 perguntas/min com rajada de 5) e `limit_conn` (ex.: 2 streams simultâneos).
  Se muitos usuários saírem pelo mesmo IP (NAT corporativo), use como chave um identificador do usuário (ex.: um
  cabeçalho definido pelo próprio Gerpro) em vez de `$binary_remote_addr`.
- **Global:** a GPU atende poucas gerações por vez. Limite as conexões totais ao backend (ex.: `limit_conn` por
  servidor) de acordo com `OLLAMA_NUM_PARALLEL` e com a capacidade medida em homologação.
- O widget exibe a mensagem do corpo `{"error":{"code","message"}}` quando a resposta segue esse formato.

### 4.6 Supervisor de processo

Rode o build (`npm ci && npm run build`) e mantenha o processo supervisionado, com reinício automático e
diretório de trabalho em `backend/`. O backend encerra de forma ordenada com `SIGINT`/`SIGTERM` (fecha o servidor e
o driver do Neo4j).

**Linux (systemd):**

```ini
[Unit]
Description=AI Gerpro backend
After=network.target ollama.service

[Service]
WorkingDirectory=/opt/ai-gerpro/backend
ExecStart=/usr/bin/node --env-file-if-exists=.env dist/server.js
Restart=on-failure
RestartSec=5
User=ai-gerpro
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

**Windows:** registre um serviço com uma ferramenta de serviço (ex.: NSSM ou WinSW) apontando para `node.exe`,
argumentos `--env-file-if-exists=.env dist\server.js`, diretório de início `...\backend`, reinício automático e
conta de serviço sem privilégios administrativos. O **Ollama** também precisa estar configurado como serviço, com
o modelo já baixado.

Health checks do balanceador/monitoramento: `GET /api/health` (processo vivo; não consulta nada) e
`GET /api/health/ollama` (200 = modelo disponível; resultado em cache por 5 s).

### 4.7 Cache e versionamento do widget

`npm run build:widget` gera **um único arquivo**, `frontend/dist-widget/ai-gerpro.js`, com nome fixo. Para que os
navegadores peguem as atualizações:

- publique em um caminho **versionado** (ex.: `/assets/ai-gerpro/0.1.0/ai-gerpro.js`) com
  `Cache-Control: public, max-age=31536000, immutable`, e atualize a referência na página a cada versão; **ou**
- mantenha o caminho fixo com `?v=<versão>` na tag `<script>` e `Cache-Control: no-cache` (revalidação por ETag).

`AIGerpro.version` (e o atributo `data-ai-gerpro` do elemento `<ai-gerpro-widget>`) informa a versão carregada
(campo `version` de `frontend/package.json`). Opcionalmente, use Subresource Integrity:

```powershell
$bytes = [IO.File]::ReadAllBytes("frontend\dist-widget\ai-gerpro.js")
"sha384-" + [Convert]::ToBase64String([Security.Cryptography.SHA384]::Create().ComputeHash($bytes))
# <script src="/assets/ai-gerpro/0.1.0/ai-gerpro.js" integrity="sha384-..." crossorigin="anonymous"></script>
```

**Content Security Policy:** se a página do Gerpro usar CSP, ela precisa permitir o script do widget (`script-src`),
o backend (`connect-src`, quando em outra origem) e o elemento `<style>` que o widget injeta no próprio Shadow DOM
(`style-src 'unsafe-inline'` ou equivalente). Validar com a CSP real em homologação.

---

## 5. Incorporar o widget em uma página do Gerpro

1. Publique `frontend/dist-widget/ai-gerpro.js` (seção 4.7). **Não há arquivo CSS**: o estilo vai embutido e é
   aplicado dentro do Shadow DOM do widget. O Gerpro **não precisa usar React**.
2. Na página:

   ```html
   <script src="/assets/ai-gerpro/0.1.0/ai-gerpro.js"></script>
   <script>
     const ai = AIGerpro.mount({
       apiBaseUrl: "/ai-gerpro/api",
       // Token curto emitido pelo backend do Gerpro, pedido a cada mensagem (obrigatório em modo corporativo).
       getAuthToken: async () => (await fetch("/gerpro/api/ai-token", { credentials: "include" })).text(),
       // Separa conversas por usuário e organização.
       conversationKey: `${usuarioId}:${organizacaoId}`,
       // showLauncher: false,   // para usar um botão próprio do Gerpro com ai.toggle()
       // position, title, streaming, defaultOpen, container, onOpenChange
     });
   </script>
   ```

3. API do objeto retornado: `open()`, `close()`, `toggle()`, `isOpen()`, `resetConversation()`,
   `setConversationKey(chave)`, `unmount()`. Também: `AIGerpro.version`.
4. **Instância única:** chamar `AIGerpro.mount()` de novo sem `unmount()` (navegação em SPA, script incluído duas
   vezes) devolve a instância existente, com um aviso no console; se a nova chamada trouxer `conversationKey`, ela é
   aplicada. Para trocar outras opções, chame `unmount()` e monte de novo.
5. **Isolamento:** o widget fica em `<ai-gerpro-widget>` com Shadow DOM aberto. Regras globais da página (inclusive
   com `!important`, `font-size` na raiz, `transform`/`opacity` no elemento) não o alteram, e o CSS do widget não
   vaza para a página. Com `container`, o elemento `<ai-gerpro-widget>` é inserido dentro dele (o container não é
   alterado e continua existindo após `unmount()`).
6. **Histórico:** a conversa visível fica inteira no painel. A cada pergunta, o widget envia ao backend só a janela
   mais recente que cabe em `CHAT_MAX_MESSAGES`/`CHAT_MAX_CHARS_PER_MESSAGE` (lidos de `GET /api/health`),
   começando sempre por uma pergunta do usuário.
7. Se a página for servida por outra origem que não a do backend, defina `CORS_ORIGIN` com essa origem (uma
   origem por implantação). Com o proxy na mesma origem do Gerpro (recomendado), o CORS não é necessário.

## 6. Avisos exibidos no widget

| Situação | Aviso no topo do painel |
|---|---|
| Recuperação desabilitada (padrão) | "O assistente **não tem acesso** a processos, contratos ou dados do Gerpro. As respostas são geradas por um modelo de IA local e podem conter erros." |
| Recuperação habilitada (a partir da 1ª resposta com `grounding` diferente de `disabled`) | "As respostas podem utilizar informações recuperadas das bases integradas ao Gerpro. Confira as fontes indicadas." |

## 7. Configurar Qdrant, Neo4j e embeddings

Tudo é opcional e fica no `backend/.env`. O passo a passo completo está em
[INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 2 a 5.

| Base | Variáveis | Regras |
|---|---|---|
| Qdrant | `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_TIMEOUT_MS` | HTTPS fora de localhost; credencial **somente leitura**; nunca cria nem altera coleções |
| Neo4j | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `NEO4J_TIMEOUT_MS` | `bolt+s://`/`neo4j+s://` fora de localhost (sem `+ssc` em modo corporativo); usuário com papel **somente leitura**; sessão `READ` |
| Embeddings | `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIMENSIONS`, `EMBEDDINGS_QUERY_PREFIX`, `EMBEDDINGS_BASE_URL` | Deve ser **o mesmo modelo usado na indexação** das coleções; não há valor padrão |
| Mapeamento | `RETRIEVAL_CONFIG_PATH` (absoluto em produção) | Arquivo sem segredos, **fora do Git** |

Para informar o modelo de embeddings: instale-o no Ollama (`ollama pull <modelo>`), defina `EMBEDDINGS_MODEL` com o
nome exato, `EMBEDDINGS_DIMENSIONS` com a dimensão do vetor das coleções e, se o modelo exigir, o prefixo de
consulta (ex.: `query: `). O diagnóstico interno (`GET /api/health/details`) e `npm run check:retrieval` avisam se
a dimensão do modelo não coincidir com a das coleções.

## 8. Mapear coleções, campos e consultas Cypher

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
- **Continuações:** mantenha `CHAT_MAX_MESSAGES ≥ 2 × RETRIEVAL_CONTEXT_TURNS + 1`, para que as perguntas
  anteriores examinadas caibam na janela enviada pelo widget (o backend avisa no log se não couberem).

Tabelas completas: [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 4 e 5. Após mapear, rode
`npm run check:retrieval -w backend`.

## 9. Autenticação, permissões e `conversationKey`

- **Chat:** com `CHAT_REQUIRE_AUTH=true` (obrigatório em modo corporativo), `/api/chat` e `/api/chat/stream`
  exigem um token válido do Gerpro **antes** de qualquer processamento: sem token → 401 "Autenticação necessária";
  token inválido/expirado → 401. Em demonstração local, o padrão é `false` (chat aberto, bases não consultadas).
  Não há login próprio: a identidade vem do Gerpro.
- **Bases:** com `GERPRO_AUTH_MODE=none` (padrão local), nada é consultado mesmo com as bases configuradas.
- **Opção A (`jwt-hs256`, implementação de referência):** o backend do Gerpro emite um JWT HS256 curto (≤ 15 min)
  com `sub` (usuário), `org` (organização), `perms` (permissões), `iss` e `aud`, assinado com
  `GERPRO_AUTH_JWT_SECRET` (≥ 32 bytes, compartilhado só entre os dois backends). O widget pede o token via
  `getAuthToken` a cada mensagem e o envia em `Authorization: Bearer`.
- **Opção B:** implementar um `AuthContextResolver` próprio em `backend/src/auth/` (OIDC/JWKS, sessão
  compartilhada, proxy reverso) e devolvê-lo em `createAuthResolver`.
- O navegador **não** envia filtros nem identidade: o corpo aceita só `messages`.
- Os valores de `org` e `perms` precisam coincidir com os gravados em `organizationField`, `permissionsField`,
  `requiredPermission` e `$auth_organizationId` (inclusive o **tipo**: texto).
- **Diagnóstico interno:** `DIAGNOSTICS_TOKEN` é uma credencial **administrativa** separada, para a equipe de
  infraestrutura. Nunca a entregue ao navegador nem a reutilize como segredo JWT.
- **`conversationKey`:** informe `usuario:organizacao` no `mount` e chame `ai.setConversationKey(...)` ao trocar de
  usuário ou organização e `ai.resetConversation()` no logout. Assim o histórico de uma sessão não passa para outra.

Detalhes: [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seções 6 e 7A.

## 10. Testes

| Comando | O que valida | Requer |
|---|---|---|
| `npm run typecheck` | Tipos do backend e do frontend | — |
| `npm test` | 141 testes do backend + 45 do frontend, com dublês e sem rede (inclui segurança, modo corporativo e recorte do histórico) | — |
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

**Validação no navegador (Etapa 4.1):** o widget compilado foi testado no Edge headless (perfil temporário) numa
página HTML sem React com CSS global agressivo, contra o backend real e o Ollama: estilos computados idênticos aos
de uma página sem CSS, teclado/foco/ARIA, API completa, instância única, 10 ciclos de montagem sem resíduos,
40 perguntas seguidas (máximo de 29 mensagens por requisição com `CHAT_MAX_MESSAGES=30`) e chat protegido por
token. Para repetir em homologação: abrir a página do Gerpro com o widget, conferir `AIGerpro.version`, fazer
mais de 15 perguntas seguidas e testar abrir/fechar/Esc e a troca de usuário.

## 11. Checklist de segurança para homologação

**Configuração**
- [ ] `APP_ENV=homologacao` (ou `producao`) e a linha `Segurança: modo corporativo (estrito)` no log.
- [ ] `backend/.env` e `retrieval.config.json` fora do Git, com permissão de leitura só para a conta do serviço.
- [ ] `GERPRO_AUTH_JWT_SECRET` e `DIAGNOSTICS_TOKEN` no cofre de segredos, diferentes entre si, ≥ 32 bytes, com
      rotação definida; tokens do Gerpro com validade de até 15 min, `iss` e `aud` corretos.
- [ ] API key do Qdrant somente leitura; usuário do Neo4j com papel somente leitura; TLS verificado nas duas.

**Rede e proxy**
- [ ] Backend acessível só pelo proxy (`HOST=127.0.0.1` ou firewall); Ollama, Qdrant e Neo4j inacessíveis aos usuários.
- [ ] Proxy expõe só `/api/chat`, `/api/chat/stream`, `/api/health` e `/api/health/ollama`; `/api/health/details`
      bloqueado na borda.
- [ ] Streaming sem buffering (o texto aparece aos poucos) e timeout do proxy maior que `OLLAMA_TIMEOUT_MS`.
- [ ] Limite de requisições por usuário/IP e de conexões simultâneas configurado e testado (resposta 429).
- [ ] `CORS_ORIGIN` só com a origem do Gerpro (ou proxy na mesma origem, sem CORS).

**Verificações funcionais**
- [ ] `POST /api/chat` sem token → 401; com token de outro emissor/audiência → 401; com token válido → 200.
- [ ] `GET /api/health/details` de fora → 403/404; com `DIAGNOSTICS_TOKEN` na rede interna → 200.
- [ ] Com o Ollama parado, a mensagem no widget não mostra endereço, porta nem servidor.
- [ ] Isolamento entre organizações conferido com dados de teste de duas organizações (Qdrant e Neo4j), incluindo
      o tipo do campo de organização.
- [ ] Troca de usuário/organização e logout no Gerpro descartam a conversa (`setConversationKey`/`resetConversation`).
- [ ] Widget com a CSP real da página e a versão esperada (`AIGerpro.version`).
- [ ] Consultas Cypher do mapeamento revisadas por quem conhece o grafo.

## 12. Atividades que dependem da Cognitiva

1. Disponibilizar instâncias de **teste ou homologação** do Qdrant e do Neo4j (o ambiente desta entrega não tem
   Docker, Java, Qdrant nem Neo4j).
2. Informar os nomes reais das coleções, campos de payload, rótulos e propriedades do grafo, e o **tipo** do campo
   de organização.
3. Informar o **modelo de embeddings** e a dimensão usados na indexação; instalá-lo no Ollama do servidor.
4. Escrever e revisar as consultas Cypher autorizadas, os vínculos entre as bases e as regex `fromQuestion` /
   `triggerTerms` dos identificadores reais (processo, contrato etc.).
5. Criar credenciais **somente leitura** (API key do Qdrant e usuário do Neo4j) e índices de payload no Qdrant.
6. Implementar no backend do Gerpro a emissão do token (Opção A, com `iss`/`aud`) ou um resolvedor próprio
   (Opção B) e definir os nomes das permissões.
7. Integrar `conversationKey` / `setConversationKey` / `resetConversation` ao login, à troca de organização e ao
   logout do Gerpro.
8. Configurar o proxy reverso (rotas, streaming, limite de requisições), o supervisor de processo, a publicação
   versionada do widget, a CSP e o cofre de segredos (seção 4).
9. Medir a capacidade da GPU (usuários simultâneos, `OLLAMA_NUM_PARALLEL`) e ajustar os limites do proxy.
10. Rodar `check:retrieval` e `test:integration` (incluindo os da seção 10A) contra as instâncias de teste.
11. Avaliar a qualidade com perguntas reais em homologação e ajustar `limit`, `scoreThreshold`,
    `RETRIEVAL_CONTEXT_TURNS` e os orçamentos de contexto.
12. Concluir o checklist da seção 11 e o de [INTEGRACAO-RECUPERACAO.md](INTEGRACAO-RECUPERACAO.md), seção 11.

## 13. Versionamento e segredos

O `.gitignore` exclui: `.env` e variantes (exceto `.env.example`), `backend/retrieval.config.json` e outras
variantes reais do mapeamento (exceto o modelo), certificados e chaves (`*.pem`, `*.key`, `*.pfx`…), logs,
temporários, `bench-results/` (respostas do modelo e dados do ambiente), builds e `node_modules/`.

Regras para a equipe:

- Nunca faça commit de `backend/.env`, `backend/retrieval.config.json`, tokens, dumps ou dados de clientes.
- Antes de cada push, confira `git status` e `git diff --cached`.
- Os únicos segredos presentes no repositório são valores **fictícios** dos testes (ex.: `TEST_SECRET` em
  `backend/test/helpers/retrieval-fakes.ts`). Não os reutilize em nenhum ambiente.
