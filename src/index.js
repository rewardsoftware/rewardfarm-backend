/**
 * Backend for a Telegram Mini App reward system.
 * All coin balances live in D1 — the frontend must NOT keep balance in
 * localStorage; it always reads/writes through this API.
 *
 * Endpoints (all POST, all require Telegram WebApp `initData`):
 *   POST /balance   { initData }                          -> current balance
 *   POST /earn      { initData, amount, type, meta? }      -> credits coins (ad reward, bonus, etc.)
 *   POST /withdraw  { initData, faucetpay_email, amount }  -> debits coins + instant FaucetPay payout
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your bot's domain in production
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "Not found" }, 404);

    if (url.pathname === "/balance") return handleBalance(request, env);
    if (url.pathname === "/earn") return handleEarn(request, env);
    if (url.pathname === "/withdraw") return handleWithdraw(request, env);

    return json({ error: "Not found" }, 404);
  },
};

// ── /balance ──────────────────────────────────────────────────────────────
async function handleBalance(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const verified = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const user = await getOrCreateUser(env, verified.user);
  return json({ balance: user.balance });
}

// ── /earn ─────────────────────────────────────────────────────────────────
async function handleEarn(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { initData, amount, type, meta } = body;
  if (!amount || typeof amount !== "number" || amount <= 0) {
    return json({ error: "Invalid amount" }, 400);
  }
  if (!type || typeof type !== "string") {
    return json({ error: "Missing type (e.g. 'ad_reward', 'daily_bonus')" }, 400);
  }

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const telegramId = String(verified.user.id);
  await getOrCreateUser(env, verified.user); // ensures row exists

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?`)
      .bind(amount, now, telegramId),
    env.DB.prepare(
      `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(telegramId, amount, type, meta ? JSON.stringify(meta) : null, now),
  ]);

  const updated = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`)
    .bind(telegramId).first();

  return json({ success: true, balance: updated.balance });
}

// ── /withdraw ─────────────────────────────────────────────────────────────
async function handleWithdraw(request, env) {
  const body = await safeJson(request);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { initData, faucetpay_email, amount } = body;
  if (!initData || !faucetpay_email || !amount) {
    return json({ error: "Missing initData, faucetpay_email, or amount" }, 400);
  }
  if (typeof amount !== "number" || amount <= 0) {
    return json({ error: "Invalid amount" }, 400);
  }

  const verified = await verifyTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return json({ error: "Telegram verification failed: " + verified.reason }, 401);

  const telegramId = String(verified.user.id);
  const telegramUsername = verified.user.username || null;
  const user = await getOrCreateUser(env, verified.user);

  // 1. Enforce per-user withdrawal cooldown
  const limitHours = Number(env.WITHDRAW_LIMIT_HOURS || "12");
  const cutoff = Date.now() - limitHours * 60 * 60 * 1000;

  const last = await env.DB.prepare(
    `SELECT created_at FROM withdrawals
     WHERE telegram_id = ? AND status = 'completed' AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).bind(telegramId, cutoff).first();

  if (last) {
    const nextAvailable = last.created_at + limitHours * 60 * 60 * 1000;
    return json({
      error: "Withdrawal limit active",
      next_available_at: nextAvailable,
      ms_remaining: nextAvailable - Date.now(),
    }, 429);
  }

  // 2. Check balance
  if (user.balance < amount) {
    return json({ error: "Insufficient balance", balance: user.balance }, 400);
  }

  // 3. Deduct balance atomically — the `AND balance >= ?` guards against
  //    a race where balance dropped between the check above and this write.
  const now = Date.now();
  const deduct = await env.DB.prepare(
    `UPDATE users SET balance = balance - ?, updated_at = ? WHERE telegram_id = ? AND balance >= ?`
  ).bind(amount, now, telegramId, amount).run();

  if (!deduct.meta || deduct.meta.changes === 0) {
    return json({ error: "Insufficient balance" }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, 'withdrawal', ?, ?)`
  ).bind(telegramId, -amount, JSON.stringify({ faucetpay_email }), now).run();

  // 4. Call FaucetPay instant payout API
  const currency = env.FAUCETPAY_CURRENCY || "USDT";
  const fpParams = new URLSearchParams({
    api_key: env.FAUCETPAY_API_KEY,
    amount: String(amount),
    to: faucetpay_email,
    currency,
  });

  let fpResult, fpOk = true;
  try {
    const fpRes = await fetch("https://faucetpay.io/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fpParams.toString(),
    });
    fpResult = await fpRes.json();
  } catch (err) {
    fpOk = false;
    fpResult = { error: String(err) };
  }

  const success = fpOk && fpResult && fpResult.status === 200;

  await env.DB.prepare(
    `INSERT INTO withdrawals
     (telegram_id, telegram_username, amount, faucetpay_email, currency, status, faucetpay_payout_id, faucetpay_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    telegramId, telegramUsername, amount, faucetpay_email, currency,
    success ? "completed" : "failed",
    fpResult?.payout_id ? String(fpResult.payout_id) : null,
    JSON.stringify(fpResult),
    now
  ).run();

  // 5. FaucetPay failed — refund the deducted coins
  if (!success) {
    const refundAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET balance = balance + ?, updated_at = ? WHERE telegram_id = ?`)
        .bind(amount, refundAt, telegramId),
      env.DB.prepare(
        `INSERT INTO coin_transactions (telegram_id, amount, type, meta, created_at) VALUES (?, ?, 'withdrawal_refund', ?, ?)`
      ).bind(telegramId, amount, JSON.stringify(fpResult), refundAt),
    ]);
    return json({ error: "FaucetPay payout failed, coins refunded", details: fpResult }, 402);
  }

  const updatedUser = await env.DB.prepare(`SELECT balance FROM users WHERE telegram_id = ?`)
    .bind(telegramId).first();

  return json({
    success: true,
    payout_id: fpResult.payout_id,
    amount,
    currency,
    balance: updatedUser.balance,
    next_available_at: now + limitHours * 60 * 60 * 1000,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
async function getOrCreateUser(env, tgUser) {
  const telegramId = String(tgUser.id);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (telegram_id, telegram_username, balance, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET telegram_username = excluded.telegram_username`
  ).bind(telegramId, tgUser.username || null, now, now).run();

  return env.DB.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(telegramId).first();
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Validates Telegram WebApp initData per Telegram's documented HMAC scheme.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
async function verifyTelegramInitData(initData, botToken) {
  if (!initData) return { ok: false, reason: "Missing initData" };
  if (!botToken) return { ok: false, reason: "Bot token not configured" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "Missing hash" };
  params.delete("hash");

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join("\n");

  const encoder = new TextEncoder();

  const webAppDataKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secretKeyBytes = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));

  const secretHmacKey = await crypto.subtle.importKey(
    "raw", secretKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", secretHmacKey, encoder.encode(dataCheckString));
  const computedHash = toHex(signature);

  if (computedHash !== hash) return { ok: false, reason: "Hash mismatch" };

  const authDate = Number(params.get("auth_date")) * 1000;
  if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "initData expired" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "Missing user field" };

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "Malformed user field" };
  }
  if (!user.id) return { ok: false, reason: "Missing user id" };

  return { ok: true, user };
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
