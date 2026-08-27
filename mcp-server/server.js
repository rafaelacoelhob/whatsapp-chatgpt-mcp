import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  EVOLUTION_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE = "ana",
  MCP_PATH_SECRET,
  BLOCKED_NUMBERS = "",
  PORT = 8080,
} = process.env;

if (!EVOLUTION_URL || !EVOLUTION_API_KEY || !MCP_PATH_SECRET) {
  console.error(
    "Faltam variáveis de ambiente: EVOLUTION_URL, EVOLUTION_API_KEY e MCP_PATH_SECRET são obrigatórias."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Lista proibida: números que NUNCA podem ser lidos. Filtro técnico aplicado
// em todas as ferramentas — mensagens/conversas desses números nem chegam
// ao ChatGPT. Formato: BLOCKED_NUMBERS="5511999999999,5521888888888"
// ---------------------------------------------------------------------------
const blocked = BLOCKED_NUMBERS.split(",")
  .map((n) => n.replace(/\D/g, ""))
  .filter((n) => n.length >= 8);

// normaliza celular BR removendo o 9º dígito p/ comparação (55 + DDD + 9XXXXXXXX)
function canon(digits) {
  if (digits.startsWith("55") && digits.length === 13) {
    return "55" + digits.slice(2, 4) + digits.slice(5);
  }
  return digits;
}

function isBlocked(jid) {
  const digits = String(jid || "").split("@")[0].replace(/\D/g, "");
  if (!digits) return false;
  const d = canon(digits);
  // cobre variações com/sem DDI e com/sem 9º dígito
  return blocked.some((b) => {
    const c = canon(b);
    return d === c || d.endsWith(c) || c.endsWith(d);
  });
}

// mensagens podem chegar com o número em campos alternativos (ex: contatos @lid)
function msgBlocked(record = {}) {
  const k = record.key || {};
  return [k.remoteJid, k.senderPn, k.remoteJidAlt, k.previousRemoteJid, record.remoteJid]
    .filter(Boolean)
    .some(isBlocked);
}

// ---------------------------------------------------------------------------
// Cliente da Evolution API
// ---------------------------------------------------------------------------
async function evo(path, body) {
  const res = await fetch(`${EVOLUTION_URL}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: { apikey: EVOLUTION_API_KEY, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Evolution API ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// A Evolution varia o formato de resposta entre versões; normaliza para array
function asRecords(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.messages?.records)) return data.messages.records;
  if (Array.isArray(data?.messages)) return data.messages;
  return [];
}

function textOf(record = {}) {
  const m = record.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    (m.audioMessage && "[áudio]") ||
    (m.imageMessage && "[imagem]") ||
    (m.videoMessage && "[vídeo]") ||
    (m.stickerMessage && "[figurinha]") ||
    (m.documentMessage && `[documento] ${m.documentMessage?.fileName || ""}`.trim()) ||
    "[mensagem não textual]"
  );
}

function whenOf(record = {}) {
  const ts = Number(record.messageTimestamp || record.timestamp || 0);
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
}

function tsOf(record = {}) {
  return Number(record.messageTimestamp || record.timestamp || 0);
}

function simplifyMessage(record = {}) {
  const jid = record.key?.remoteJid || record.remoteJid || "";
  return {
    conversa: jid,
    numero: jid.split("@")[0],
    contato: record.pushName || null,
    enviada_por_mim: Boolean(record.key?.fromMe),
    quando: whenOf(record),
    texto: textOf(record),
  };
}

function resolveJid(chat) {
  const value = String(chat || "").trim();
  if (value.includes("@")) return value; // já é um JID (inclui grupos @g.us)
  const digits = value.replace(/\D/g, "");
  if (!digits) throw new Error(`Identificador de conversa inválido: "${chat}"`);
  return `${digits}@s.whatsapp.net`;
}

function sinceTs(since) {
  if (!since) return 0;
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) throw new Error(`Data inválida em "since": ${since}`);
  return parsed / 1000;
}

const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

// ---------------------------------------------------------------------------
// Servidor MCP e ferramentas
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: "whatsapp", version: "1.0.0" });

  // Todas as ferramentas são estritamente de leitura — as annotations abaixo
  // declaram isso ao cliente (ChatGPT rotula certo e pede menos permissão).
  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "list_chats",
    {
      description: "Lista as conversas recentes do WhatsApp (individuais e grupos), com nome e identificador. Somente leitura.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Máximo de conversas (padrão 30)") },
      annotations: READ_ONLY,
    },
    async ({ limit = 30 }) => {
      const data = await evo(`/chat/findChats/${EVOLUTION_INSTANCE}`, {});
      const chats = asRecords(data)
        .map((c) => ({
          conversa: c.remoteJid || c.id || "",
          nome: c.pushName || c.name || null,
          grupo: String(c.remoteJid || c.id || "").endsWith("@g.us"),
        }))
        .filter((c) => c.conversa && !isBlocked(c.conversa))
        .slice(0, limit);
      return json(chats);
    }
  );

  server.registerTool(
    "find_contact",
    {
      description: "Busca contatos do WhatsApp por nome ou número. Use antes de get_messages quando só souber o nome. Somente leitura.",
      inputSchema: { query: z.string().min(2).describe("Nome (ou parte) ou número do contato") },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const data = await evo(`/chat/findContacts/${EVOLUTION_INSTANCE}`, { where: {} });
      const q = query.toLowerCase();
      const qDigits = query.replace(/\D/g, "");
      const results = asRecords(data)
        .map((c) => ({
          conversa: c.remoteJid || c.id || "",
          nome: c.pushName || c.name || null,
        }))
        .filter((c) => c.conversa && !isBlocked(c.conversa))
        .filter(
          (c) =>
            (c.nome && c.nome.toLowerCase().includes(q)) ||
            (qDigits.length >= 4 && c.conversa.includes(qDigits))
        )
        .slice(0, 20);
      return json(results);
    }
  );

  server.registerTool(
    "get_messages",
    {
      description: "Busca as mensagens de UMA conversa específica do WhatsApp (contato ou grupo). Somente leitura.",
      inputSchema: {
        chat: z.string().describe("Número com DDI (ex: 5511999999999) ou JID retornado por list_chats/find_contact"),
        limit: z.number().int().min(1).max(500).optional().describe("Máximo de mensagens (padrão 50)"),
        since: z.string().optional().describe("Só mensagens a partir desta data/hora (ISO, ex: 2026-07-27 ou 2026-07-27T08:00:00-03:00)"),
      },
      annotations: READ_ONLY,
    },
    async ({ chat, limit = 50, since }) => {
      const jid = resolveJid(chat);
      if (isBlocked(jid)) {
        return json({ erro: "Este contato está na lista de conversas protegidas e não pode ser lido." });
      }
      const data = await evo(`/chat/findMessages/${EVOLUTION_INSTANCE}`, {
        where: { key: { remoteJid: jid } },
      });
      const cutoff = sinceTs(since);
      const messages = asRecords(data)
        .filter((r) => !msgBlocked(r))
        .filter((r) => tsOf(r) >= cutoff)
        .sort((a, b) => tsOf(a) - tsOf(b))
        .slice(-limit)
        .map(simplifyMessage);
      return json({ conversa: jid, total: messages.length, mensagens: messages });
    }
  );

  server.registerTool(
    "get_recent_messages",
    {
      description: "Busca as mensagens mais recentes de TODAS as conversas do WhatsApp. Útil para resumos do dia. Somente leitura.",
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe("Máximo de mensagens (padrão 200)"),
        since: z.string().optional().describe("Só mensagens a partir desta data/hora (ISO, ex: 2026-07-27)"),
      },
      annotations: READ_ONLY,
    },
    async ({ limit = 200, since }) => {
      const data = await evo(`/chat/findMessages/${EVOLUTION_INSTANCE}`, { where: {} });
      const cutoff = sinceTs(since);
      const messages = asRecords(data)
        .filter((r) => !msgBlocked(r))
        .filter((r) => tsOf(r) >= cutoff)
        .sort((a, b) => tsOf(a) - tsOf(b))
        .slice(-limit)
        .map(simplifyMessage);
      return json({ total: messages.length, mensagens: messages });
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP (Streamable HTTP transport, sem estado — uma sessão por requisição)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post(`/mcp/${MCP_PATH_SECRET}`, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Erro interno" },
        id: null,
      });
    }
  }
});

// Transporte sem estado: GET/DELETE de sessão não se aplicam
app.get(`/mcp/${MCP_PATH_SECRET}`, (_req, res) => res.status(405).end());
app.delete(`/mcp/${MCP_PATH_SECRET}`, (_req, res) => res.status(405).end());

app.listen(Number(PORT), () => {
  console.log(`MCP WhatsApp no ar na porta ${PORT}`);
  console.log(`Endpoint: /mcp/<segredo> | Instância Evolution: ${EVOLUTION_INSTANCE}`);
  console.log(`Números protegidos configurados: ${blocked.length}`);
});
