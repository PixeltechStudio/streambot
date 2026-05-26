/**
 * StreamBot CRM — Servidor Webhook para Chatbot Automático
 * Integra Z-API (WhatsApp) + Backendless
 *
 * Instalar: npm install express
 * Rodar:    node webhook-server.js
 * Deploy:   Railway.app, Render.com ou qualquer VPS
 *
 * NOTA: node-fetch foi removido — fetch é nativo no Node 18+
 */

const express = require('express');
const app = express();
app.use(express.json());

// ==================== CONFIGURAÇÃO ====================
const CONFIG = {
  // Backendless
  BL_APP_ID:  process.env.BL_APP_ID  || '',
  BL_API_KEY: process.env.BL_API_KEY || '',
  // Z-API
  ZAPI_INSTANCE: process.env.ZAPI_INSTANCE || '',
  ZAPI_TOKEN:    process.env.ZAPI_TOKEN    || '',
  ZAPI_URL:      process.env.ZAPI_URL      || 'https://api.z-api.io',
  API_TYPE:      process.env.API_TYPE      || 'zapi', // 'zapi' ou 'evolution'
  PORT:          process.env.PORT          || 3000,
  // Rate limiting simples (em memória)
  RATE_LIMIT_MAX:    parseInt(process.env.RATE_LIMIT_MAX    || '20'),  // mensagens
  RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW || '60'), // segundos
};

// Valida configurações obrigatórias na inicialização
(function validateConfig() {
  const required = ['BL_APP_ID', 'BL_API_KEY', 'ZAPI_INSTANCE', 'ZAPI_TOKEN'];
  const missing = required.filter(k => !CONFIG[k]);
  if (missing.length) {
    console.warn(`⚠️  Variáveis de ambiente não configuradas: ${missing.join(', ')}`);
    console.warn('   Configure via .env ou variáveis de ambiente antes de colocar em produção.');
  }
})();

const BL_URL = `https://api.backendless.com/${CONFIG.BL_APP_ID}/${CONFIG.BL_API_KEY}`;

// ==================== RATE LIMITING (em memória) ====================
// Para produção, substitua por Redis + sliding window
const rateLimitStore = {};

function isRateLimited(phone) {
  const now = Date.now();
  const windowMs = CONFIG.RATE_LIMIT_WINDOW * 1000;
  if (!rateLimitStore[phone]) {
    rateLimitStore[phone] = { count: 1, start: now };
    return false;
  }
  const entry = rateLimitStore[phone];
  if (now - entry.start > windowMs) {
    // Reinicia janela
    rateLimitStore[phone] = { count: 1, start: now };
    return false;
  }
  entry.count++;
  return entry.count > CONFIG.RATE_LIMIT_MAX;
}

// Limpa entradas antigas a cada 10 minutos para evitar vazamento de memória
setInterval(() => {
  const cutoff = Date.now() - CONFIG.RATE_LIMIT_WINDOW * 1000 * 2;
  for (const phone of Object.keys(rateLimitStore)) {
    if (rateLimitStore[phone].start < cutoff) delete rateLimitStore[phone];
  }
}, 10 * 60 * 1000);

// ==================== SANITIZAÇÃO ====================

/**
 * Remove caracteres que podem causar injeção nas queries do Backendless.
 * Mantém apenas dígitos para telefone.
 */
function sanitizePhone(raw) {
  return (raw || '').replace(/[^0-9]/g, '').substring(0, 20);
}

/**
 * Escapa aspas simples e remove caracteres perigosos para LIKE queries.
 */
function sanitizeString(raw, maxLen = 100) {
  return (raw || '')
    .replace(/'/g, "''")   // escapa aspas simples (padrão SQL)
    .replace(/[\\]/g, '')  // remove backslash
    .substring(0, maxLen);
}

/**
 * Valida companyId: apenas alfanuméricos, hífens e underscores.
 */
function isValidCompanyId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id || '');
}

// ==================== ESTADO DE CONVERSA ====================
// ⚠️  Em memória: perdido ao reiniciar. Para produção use Redis.
// Exemplo com ioredis:
//   const redis = new Redis(process.env.REDIS_URL);
//   await redis.set(`state:${phone}`, JSON.stringify(state), 'EX', 3600);
//   const raw = await redis.get(`state:${phone}`);
//   const state = raw ? JSON.parse(raw) : { step: 'menu' };
const conversationState = {};

// ==================== BACKENDLESS HELPERS ====================
async function blGet(table, where, pageSize = 100) {
  const url = `${BL_URL}/data/${table}?where=${encodeURIComponent(where)}&pageSize=${pageSize}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BL GET ${table} [${res.status}]: ${body}`);
  }
  return res.json();
}

async function blCreate(table, data) {
  const res = await fetch(`${BL_URL}/data/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BL CREATE ${table} [${res.status}]: ${body}`);
  }
  return res.json();
}

async function blUpdate(table, id, data) {
  const res = await fetch(`${BL_URL}/data/${table}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BL UPDATE ${table} [${res.status}]: ${body}`);
  }
  return res.json();
}

// ==================== ZAPI / EVOLUTION HELPERS ====================
async function sendMessage(phone, message) {
  const num = sanitizePhone(phone);
  const fullNum = num.startsWith('55') ? num : '55' + num;

  console.log(`[DEBUG] sendMessage → phone: ${fullNum}, API_TYPE: ${CONFIG.API_TYPE}`);
  console.log(`[DEBUG] ZAPI_INSTANCE: ${CONFIG.ZAPI_INSTANCE ? '✅ configurado' : '❌ VAZIO'}`);
  console.log(`[DEBUG] ZAPI_TOKEN: ${CONFIG.ZAPI_TOKEN ? '✅ configurado' : '❌ VAZIO'}`);
  console.log(`[DEBUG] ZAPI_URL: ${CONFIG.ZAPI_URL}`);

  if (CONFIG.API_TYPE === 'evolution') {
    const res = await fetch(
      `${CONFIG.ZAPI_URL}/message/sendText/${CONFIG.ZAPI_INSTANCE}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: CONFIG.ZAPI_TOKEN },
        body: JSON.stringify({ number: fullNum, textMessage: { text: message } }),
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Evolution API error [${res.status}]: ${err}`);
    }
    return res.json();
  } else {
    const res = await fetch(
      `${CONFIG.ZAPI_URL}/instances/${CONFIG.ZAPI_INSTANCE}/token/${CONFIG.ZAPI_TOKEN}/send-text`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: fullNum, message }),
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Z-API error [${res.status}]: ${err}`);
    }
    return res.json();
  }
}

// ==================== CHATBOT ENGINE ====================
async function getChatbotConfig(companyId) {
  try {
    const safe = sanitizeString(companyId, 64);
    const list = await blGet('ConfigChatbot', `companyId='${safe}'`, 1);
    return list[0] || null;
  } catch (e) {
    console.error('getChatbotConfig error:', e.message);
    return null;
  }
}

async function getClient(phone, companyId) {
  const num = sanitizePhone(phone);
  const safeCompany = sanitizeString(companyId, 64);
  try {
    const results = await blGet(
      'ClientesStreaming',
      `companyId='${safeCompany}' AND (telefone='${num}' OR telefone='55${num}' OR telefone='+55${num}')`,
      1
    );
    return results[0] || null;
  } catch (e) {
    console.error('getClient error:', e.message);
    return null;
  }
}

async function getPlans(companyId) {
  const safeCompany = sanitizeString(companyId, 64);
  try {
    return await blGet('PlanosStreaming', `companyId='${safeCompany}' AND status='Ativo'`, 20);
  } catch (e) {
    console.error('getPlans error:', e.message);
    return [];
  }
}

async function getFAQ(companyId, keyword) {
  const safeCompany = sanitizeString(companyId, 64);
  const safeKeyword = sanitizeString(keyword, 50);
  try {
    return await blGet(
      'FAQChatbot',
      `companyId='${safeCompany}' AND status='Ativo' AND (pergunta LIKE '%${safeKeyword}%' OR palavrasChave LIKE '%${safeKeyword}%')`,
      5
    );
  } catch (e) {
    console.error('getFAQ error:', e.message);
    return [];
  }
}

async function saveConversation(companyId, phone, clienteId, nomeCliente, mensagem, status) {
  const safeCompany = sanitizeString(companyId, 64);
  const safePhone   = sanitizePhone(phone);
  try {
    const convs = await blGet(
      'Conversas',
      `companyId='${safeCompany}' AND telefone='${safePhone}' AND statusAtendimento!='Finalizado'`,
      1
    );
    if (convs.length > 0) {
      await blUpdate('Conversas', convs[0].objectId, {
        ultimaMensagem: mensagem.substring(0, 100),
        dataUltimaMensagem: new Date().toISOString(),
        statusAtendimento: status || convs[0].statusAtendimento,
      });
      return convs[0];
    } else {
      return await blCreate('Conversas', {
        companyId: safeCompany,
        clienteId: clienteId || '',
        nomeCliente,
        telefone: safePhone,
        canal: 'WhatsApp',
        statusAtendimento: status || 'Novo',
        prioridade: 'Normal',
        ultimaMensagem: mensagem.substring(0, 100),
        dataUltimaMensagem: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('saveConversation error:', e.message);
  }
}

// ==================== UTILITÁRIOS ====================
function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Verifica se o horário atual (fuso de São Paulo) está dentro da janela configurada.
 * @param {string} range — formato "HH:MM-HH:MM"
 */
function isWithinBusinessHours(range) {
  if (!range) return true; // sem restrição configurada
  const [inicio, fim] = range.split('-');
  if (!inicio || !fim) return true;

  const now = new Date();
  // Converte para horário de Brasília
  const brTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const h = brTime.getHours();
  const m = brTime.getMinutes();
  const [ih, im] = inicio.split(':').map(Number);
  const [fh, fm] = fim.split(':').map(Number);
  const nowMin = h * 60 + m;

  return nowMin >= ih * 60 + im && nowMin <= fh * 60 + fm;
}

function buildMenu(cfg, client) {
  const greeting = client ? `Olá, *${client.nome}*! 👋` : `Olá! 👋`;
  const welcome  = cfg?.mensagemBoasVindas || 'Seja bem-vindo ao nosso atendimento! 😊';
  return (
    `${greeting}\n\n${welcome}\n\n` +
    `Como posso te ajudar?\n\n` +
    `1️⃣ Renovar meu plano\n` +
    `2️⃣ Ver meu plano atual\n` +
    `3️⃣ Problema no acesso\n` +
    `4️⃣ Ver planos e preços\n` +
    `5️⃣ Formas de pagamento\n` +
    `6️⃣ Falar com atendente\n\n` +
    `Digite o número da opção desejada.`
  );
}

// ==================== PROCESSAMENTO DE MENSAGEM ====================
async function processMessage(companyId, phone, text, senderName) {
  const cfg = await getChatbotConfig(companyId);

  // Verifica se o bot está ativo
  if (cfg && cfg.statusBot !== 'Ativo') {
    return cfg.mensagemForaHorario || 'Atendimento encerrado no momento. Em breve retornaremos!';
  }

  // Verifica horário (usando fuso de Brasília)
  if (cfg && cfg.horarioAtendimento && !isWithinBusinessHours(cfg.horarioAtendimento)) {
    return cfg.mensagemForaHorario || '⏰ Nosso atendimento está fora do horário. Retornaremos em breve!';
  }

  const client   = await getClient(phone, companyId);
  const state    = conversationState[phone] || { step: 'menu' };
  const input    = (text || '').trim().toLowerCase();
  const numInput = parseInt(input, 10);

  // Palavras que resetam para o menu
  const resetWords = ['menu', 'início', 'inicio', 'oi', 'olá', 'ola', 'hi', 'hello', 'ajuda', 'help', '0', 'voltar'];
  if (resetWords.includes(input)) {
    conversationState[phone] = { step: 'menu' };
    return buildMenu(cfg, client);
  }

  // Primeiro contato ou passo "menu" → exibe menu e aguarda opção
  if (state.step === 'menu' || !state.step) {
    conversationState[phone] = { step: 'awaiting_option' };
    return buildMenu(cfg, client);
  }

  // ── Aguardando escolha do menu ──────────────────────────────────
  if (state.step === 'awaiting_option') {
    // 1 — Renovar plano
    if (numInput === 1) {
      if (!client) {
        conversationState[phone] = { step: 'menu' };
        return `Para renovar seu plano, entre em contato diretamente conosco.\n\nDigite *menu* para voltar.`;
      }
      const venc    = formatDate(client.dataVencimento);
      const pix     = cfg?.pixChave || 'consulte o suporte';
      const pixNome = cfg?.pixNome  || '';
      conversationState[phone] = { step: 'menu' };
      return (
        `💰 *Renovação de Plano*\n\n` +
        `👤 Cliente: *${client.nome}*\n` +
        `📦 Plano: *${client.planoId || '-'}*\n` +
        `📅 Vencimento: *${venc}*\n` +
        `💵 Valor: *R$ ${parseFloat(client.valorMensal || 0).toFixed(2)}*\n\n` +
        `✅ *Como pagar:*\nPIX: \`${pix}\`\n` +
        `${pixNome ? `Nome: ${pixNome}\n` : ''}` +
        `\nApós o pagamento, envie o comprovante que ativo na hora! 🚀\n\nDigite *menu* para voltar.`
      );
    }

    // 2 — Ver plano atual
    if (numInput === 2) {
      if (!client) {
        conversationState[phone] = { step: 'menu' };
        return `Não encontrei seu cadastro. Entre em contato conosco.\n\nDigite *menu* para voltar.`;
      }
      const venc        = formatDate(client.dataVencimento);
      const statusEmoji = client.status === 'Ativo' ? '✅' : client.status === 'Vencido' ? '⚠️' : '❌';
      conversationState[phone] = { step: 'menu' };
      return (
        `📋 *Seu Plano Atual*\n\n` +
        `👤 *${client.nome}*\n` +
        `📦 Plano: *${client.planoId || '-'}*\n` +
        `${statusEmoji} Status: *${client.status || 'Ativo'}*\n` +
        `📅 Vencimento: *${venc}*\n` +
        `💵 Valor: *R$ ${parseFloat(client.valorMensal || 0).toFixed(2)}/mês*\n\n` +
        `${client.status === 'Vencido' ? '⚠️ Seu plano está vencido! Renove para continuar usando.\n\n' : ''}` +
        `Digite *1* para renovar ou *menu* para voltar.`
      );
    }

    // 3 — Problema no acesso
    if (numInput === 3) {
      if (client) {
        conversationState[phone] = { step: 'menu' };
        // ⚠️  SEGURANÇA: credenciais NÃO são enviadas diretamente.
        // O cliente é orientado a acionar o suporte para recebê-las com segurança.
        return (
          `🔧 *Suporte Técnico*\n\n` +
          `Para receber seus dados de acesso com segurança, ` +
          `por favor responda *6* para falar com um atendente que enviará as informações diretamente.\n\n` +
          `Você também pode verificar seu e-mail de cadastro, onde os dados foram enviados no ato da ativação.\n\n` +
          `Digite *menu* para voltar.`
        );
      }
      conversationState[phone] = { step: 'awaiting_support_msg' };
      return `🔧 *Suporte Técnico*\n\nDescreva o problema que está enfrentando e nossa equipe vai te ajudar! 👇`;
    }

    // 4 — Ver planos
    if (numInput === 4) {
      const plans = await getPlans(companyId);
      if (!plans.length) {
        conversationState[phone] = { step: 'menu' };
        return `No momento não temos planos cadastrados. Entre em contato conosco!\n\nDigite *menu* para voltar.`;
      }
      const planText = plans
        .map((p, i) => `${i + 1}. *${p.nomePlano}* — R$ ${parseFloat(p.valor || 0).toFixed(2)}/mês\n   ${p.descricao || ''}`)
        .join('\n\n');
      conversationState[phone] = { step: 'menu' };
      return `📦 *Nossos Planos*\n\n${planText}\n\nPara contratar, entre em contato!\n\nDigite *menu* para voltar.`;
    }

    // 5 — Formas de pagamento
    if (numInput === 5) {
      const pix     = cfg?.pixChave || 'consulte o suporte';
      const pixNome = cfg?.pixNome  || '';
      conversationState[phone] = { step: 'menu' };
      return (
        `💳 *Formas de Pagamento*\n\n` +
        `✅ *PIX (recomendado)*\nChave: \`${pix}\`\n` +
        `${pixNome ? `Nome: *${pixNome}*\n` : ''}` +
        `Pagamento instantâneo! Ativa na hora. ⚡\n\n` +
        `Após pagar, envie o comprovante aqui mesmo. 📩\n\nDigite *menu* para voltar.`
      );
    }

    // 6 — Falar com atendente
    if (numInput === 6) {
      conversationState[phone] = { step: 'waiting_human', waiting: true };
      await saveConversation(companyId, phone, client?.objectId, client?.nome || senderName, text, 'Novo');
      return (
        `👨‍💼 *Transferindo para Atendimento Humano*\n\n` +
        `Um de nossos atendentes vai te responder em breve!\n\n` +
        `⏰ Horário de atendimento: *${cfg?.horarioAtendimento || '08:00-18:00'}*\n\n` +
        `Fique à vontade para deixar sua mensagem. 😊`
      );
    }

    return `Não entendi. Digite o *número* da opção desejada (1 a 6).\n\nDigite *menu* para ver as opções.`;
  }

  // ── Aguardando descrição do problema (suporte sem cadastro) ──────
  if (state.step === 'awaiting_support_msg') {
    await saveConversation(companyId, phone, client?.objectId, client?.nome || senderName, text, 'Suporte');
    conversationState[phone] = { step: 'waiting_human' };
    return (
      `✅ *Mensagem recebida!*\n\n` +
      `Sua solicitação foi registrada e nossa equipe vai te ajudar em breve.\n\n` +
      `⏰ Resposta em até 2 horas no horário comercial.\n\nDigite *menu* para voltar ao início.`
    );
  }

  // ── Em atendimento humano: apenas registra, não responde ─────────
  if (state.step === 'waiting_human') {
    await saveConversation(companyId, phone, client?.objectId, client?.nome || senderName, text, 'Em atendimento');
    return null;
  }

  // Fallback
  conversationState[phone] = { step: 'menu' };
  return buildMenu(cfg, client);
}

// ==================== WEBHOOK ENDPOINT ====================
app.post('/webhook/:companyId', async (req, res) => {
  res.sendStatus(200); // Responde rápido para a Z-API não retentar

  try {
    const { companyId } = req.params;

    // Valida companyId antes de qualquer processamento
    if (!isValidCompanyId(companyId)) {
      console.warn(`companyId inválido recebido: ${companyId}`);
      return;
    }

    const body = req.body;
    let phone, text, senderName, isFromMe;

    // Log completo do payload para debug (remova em produção após confirmar funcionamento)
    console.log(`[DEBUG] Payload recebido:`, JSON.stringify(body).substring(0, 500));

    if (body.type === 'ReceivedCallback' || body.phone || body.from) {
      // Formato Z-API
      isFromMe   = body.fromMe || false;
      phone      = (body.phone || body.from || '').replace('@c.us', '').replace('@s.whatsapp.net', '');
      // Z-API pode enviar o texto em diferentes campos dependendo da versão
      text       = body.text?.message || body.body || body.message || body.caption || '';
      senderName = body.senderName || body.pushName || body.notifyName || 'Cliente';
    } else if (body.data?.key || body.event) {
      // Formato Evolution API
      isFromMe   = body.data?.key?.fromMe || false;
      phone      = body.data?.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@c.us', '') || '';
      text       = body.data?.message?.conversation
                || body.data?.message?.extendedTextMessage?.text
                || body.data?.message?.imageMessage?.caption
                || '';
      senderName = body.data?.pushName || 'Cliente';
    } else {
      console.log(`[DEBUG] Payload não reconhecido, ignorando. Keys recebidas: ${Object.keys(body).join(', ')}`);
      return;
    }

    // Ignora mensagens enviadas pelo bot, grupos e sem texto
    if (isFromMe) {
      console.log(`[DEBUG] Ignorando mensagem própria (fromMe=true)`);
      return;
    }
    if (phone.includes('@g.us') || phone.includes('-')) {
      console.log(`[DEBUG] Ignorando grupo: ${phone}`);
      return;
    }
    if (!text || !text.trim()) {
      console.log(`[DEBUG] Texto vazio, ignorando. Body keys: ${Object.keys(req.body).join(', ')}`);
      return;
    }

    // Rate limiting
    if (isRateLimited(phone)) {
      console.warn(`[${companyId}] Rate limit atingido para ${phone}`);
      return;
    }

    console.log(`[${companyId}] Mensagem de ${sanitizePhone(phone)}: ${text.substring(0, 80)}`);

    const response = await processMessage(companyId, phone, text, senderName);

    if (response) {
      await sendMessage(phone, response);
      console.log(`[${companyId}] Resposta enviada para ${sanitizePhone(phone)}`);
    } else {
      console.log(`[${companyId}] Nenhuma resposta gerada (atendimento humano ou null)`);
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

// ==================== HEALTH CHECKS ====================
app.get('/', (_req, res) =>
  res.json({ status: 'ok', message: 'StreamBot Webhook Server rodando!' })
);
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', uptime: process.uptime() })
);

app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 StreamBot Webhook Server rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Endpoint: POST /webhook/:companyId`);
  console.log(`🔧 API Type: ${CONFIG.API_TYPE}`);
  console.log(`\nConfigure na Z-API:`);
  console.log(`  URL: https://SEU_SERVIDOR/webhook/SEU_COMPANY_ID\n`);
});
