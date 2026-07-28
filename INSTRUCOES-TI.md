# Pedido pra quem gerencia o servidor do n8n (n8nops.livemode.com)

## O que é

Projeto interno (Renato Bastos / Ana Savoia): conectar o WhatsApp da Ana ao
ChatGPT Business da Livemode pra gerar relatórios das agências. Precisa de 3
containers rodando no mesmo servidor onde já roda o n8n (ou em qualquer
máquina da empresa que fique ligada).

- **postgres** — banco interno (sessão do WhatsApp + mensagens). Volume Docker, sem porta pública.
- **evolution** — Evolution API (open-source, ponte com o WhatsApp via QR code). Porta 8080, pode ficar só na rede interna.
- **mcp** — servidor pequeno em Node que o ChatGPT acessa. Porta 8090 → **precisa de HTTPS público** (ex.: `wamcp.livemode.com` no mesmo reverse proxy do n8n).

## Instalação

```bash
git clone <este-repositorio> whatsapp-chatgpt-ana
cd whatsapp-chatgpt-ana
cp .env.example .env
# preencher o .env (senhas longas aleatórias; instruções no próprio arquivo)
docker compose up -d
```

Depois, no reverse proxy (nginx/traefik/caddy), apontar um subdomínio com TLS
para a porta **8090** (serviço `mcp`). Somente o caminho `/mcp/<segredo>` e
`/healthz` respondem — o resto é 404.

## Segurança

- O endpoint público exige um segredo longo na URL (`MCP_PATH_SECRET`); sem ele, nada responde.
- A Evolution API fica atrás da `EVOLUTION_API_KEY` e não precisa ser exposta publicamente (o QR code é escaneado uma vez, via acesso interno ao painel `http://<servidor>:8080/manager`).
- Existe uma lista de números bloqueados (`BLOCKED_NUMBERS`) filtrada no servidor — conversas desses números nunca saem da máquina.
- Ciente de que a Evolution usa a ponte estilo WhatsApp Web (não-oficial da Meta) — mesmo mecanismo de qualquer ferramenta dessa categoria.

## Recursos

Consumo leve: ~600 MB de RAM no total, disco cresce devagar (texto de mensagens).

Qualquer dúvida: Renato Bastos (rbastos@livemode.com).
