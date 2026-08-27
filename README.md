# WhatsApp → ChatGPT (via MCP)

Conecta um WhatsApp ao ChatGPT: cada cliente/agência vira um Projeto no
ChatGPT, com relatório do dia (via Agendados) e perguntas livres sobre as
conversas. Custo zero — tudo open-source/self-hosted.

```
WhatsApp ←QR code→ Evolution API ←→ servidor MCP ←→ ChatGPT (Modo de desenvolvedor)
                               ↓
                        Postgres (sessão + mensagens)
```

## Estrutura

| Arquivo | O que é |
|---|---|
| `docker-compose.yml` | Instalação completa em um comando numa VPS (Postgres + Evolution + MCP + HTTPS) |
| `.env.example` | Variáveis a preencher (senhas, número da instância, lista de bloqueio, domínio) |
| `mcp-server/` | O conector que o ChatGPT acessa (Node, 4 ferramentas: listar conversas, buscar contato, mensagens de uma conversa, mensagens recentes) |
| `render.yaml` | Plano B: deploy no Render free + Postgres gratuito externo, se não houver VPS |

## Roteiro de implantação

### 1. Infra (~15 min, numa VPS Ubuntu com Docker)

```bash
git clone https://github.com/rafaelacoelhob/whatsapp-chatgpt-mcp.git
cd whatsapp-chatgpt-mcp
cp .env.example .env
nano .env   # preencher senhas e domínio (instruções no próprio arquivo)
docker compose up -d
```

Requisito: um domínio/subdomínio apontando pro IP da VPS (registro A) — o
Caddy emite o certificado HTTPS sozinho.

### 2. Conectar o WhatsApp (2 min, uma vez)

1. Acessar o painel da Evolution: `http://<servidor>:8080/manager` (login = `EVOLUTION_API_KEY`)
2. Criar instância com o nome definido em `EVOLUTION_INSTANCE` (integração: Baileys)
3. No celular: WhatsApp → Configurações → Dispositivos conectados → Conectar dispositivo → escanear o QR

> Teste primeiro com o SEU número; depois repete com o número definitivo (trocando `EVOLUTION_INSTANCE` ou criando outra instância).

### 3. Plugar no ChatGPT (3 min)

1. ChatGPT → Configurações → Plugins → **Modo de desenvolvedor** → criar conector
2. URL: `https://<dominio-do-mcp>/mcp/<MCP_PATH_SECRET>`
3. Testar num chat: *"Liste minhas conversas recentes do WhatsApp"* e *"Resume as mensagens que recebi hoje"*

### 4. Projetos por agência (2 min cada)

Criar um Projeto no ChatGPT por agência com estas instruções (adaptar):

```
Você acompanha as conversas da AGÊNCIA X no meu WhatsApp (use as
ferramentas do conector WhatsApp).

Contatos conhecidos da agência:
- Fulana — +55 11 9XXXX-XXXX
- Grupo "Agência X"

Contatos novos: se uma conversa de número desconhecido claramente for
desta agência, inclua no relatório na seção "🆕 Contato novo — confirmar".
Só trate como contato fixo depois que eu confirmar.

Relatório do dia — quando eu pedir, busque as mensagens de hoje e
organize em: 📌 Decisões / ⏳ Pendências / 📅 Prazos / ❗ Precisa de
resposta / 🆕 Contatos novos.

Responda sempre em português, direto. Se a informação não estiver nas
conversas, diga que não está — não invente.
```

### 5. Relatório diário automático

ChatGPT → Agendados → nova tarefa: *"Todo dia às 18h, busque no WhatsApp as
mensagens de hoje da [agência/contatos] e gere o relatório do dia no formato
Decisões / Pendências / Prazos / Precisa de resposta / Contatos novos."*
(Business: até 15 tarefas ativas; acima disso, usar uma tarefa única que cobre
todas as agências.)

## Lista de números proibidos

`BLOCKED_NUMBERS` no `.env` (com DDI, separados por vírgula). É um filtro
**técnico no servidor**: conversas desses números nunca são entregues ao
ChatGPT, independente do que se peça. Alterou o .env → `docker compose up -d`
de novo pra aplicar.

## Manutenção (o que pode acontecer)

- **Sessão do WhatsApp caiu** (raro): reescanear o QR no painel da Evolution (passo 2).
- **Servidor reiniciou**: containers voltam sozinhos (`restart: always`); a sessão sobrevive (fica no Postgres).
- **Desconectar de vez**: no celular, Dispositivos conectados → encerrar sessão; `docker compose down`; remover o conector no ChatGPT.

## Avisos

- A Evolution usa a ponte estilo WhatsApp Web — **não é oficial da Meta**. Risco de banimento baixo pra leitura, mas não nulo; o dono do número deve estar ciente.
- As conversas transitam pelo servidor e pela OpenAI (padrão do ChatGPT).
