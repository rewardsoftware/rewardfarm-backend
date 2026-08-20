-- Run once via: wrangler d1 execute rewardsoftware-db --file=./schema.sql

-- Every user's coin balance lives here — server-side, not localStorage.
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  telegram_username TEXT,
  balance REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every balance change (ad reward, bonus, withdrawal deduction) is logged here.
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  amount REAL NOT NULL,               -- positive = credit, negative = debit
  type TEXT NOT NULL,                 -- 'ad_reward' | 'daily_bonus' | 'withdrawal' | 'withdrawal_refund' | ...
  meta TEXT,                          -- optional JSON details (e.g. ad network name)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coin_tx_telegram_created
  ON coin_transactions (telegram_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  telegram_username TEXT,
  amount REAL NOT NULL,
  faucetpay_email TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDT',
  status TEXT NOT NULL,               -- 'completed' | 'failed'
  faucetpay_payout_id TEXT,
  faucetpay_response TEXT,
  created_at INTEGER NOT NULL         -- unix ms timestamp
);

-- Speeds up the "last withdrawal in past 12h for this user" lookup
CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_created
  ON withdrawals (telegram_id, created_at);

