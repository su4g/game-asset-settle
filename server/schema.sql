CREATE TABLE IF NOT EXISTS ledger_accounts (
  id text PRIMARY KEY,
  label text NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ledger_accounts (id, label) VALUES ('local', '本机交易账本') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ledger_trades (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  platform text NOT NULL CHECK (platform IN ('buff','steam')),
  direction text NOT NULL CHECK (direction IN ('knife','cashout')),
  appid integer NOT NULL CHECK (appid IN (730,570)),
  market_hash_name text NOT NULL,
  name text NOT NULL,
  goods_id text,
  order_id text,
  fill_id text,
  quantity integer NOT NULL CHECK (quantity > 0),
  buy_total_cents bigint NOT NULL CHECK (buy_total_cents >= 0 AND buy_total_cents <= 9007199254740991),
  bought_at timestamptz NOT NULL,
  delivered_at timestamptz,
  tradable_at timestamptz,
  marketable_at timestamptz,
  confirmed boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  source_url text NOT NULL DEFAULT '',
  legacy_key text UNIQUE,
  snapshot jsonb NOT NULL DEFAULT '{}',
  original jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((platform = 'buff' AND direction = 'knife') OR (platform = 'steam' AND direction = 'cashout'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_fill_unique ON ledger_trades(account_id,platform,fill_id) WHERE fill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_trades_date ON ledger_trades(account_id,bought_at DESC);

CREATE TABLE IF NOT EXISTS ledger_settlements (
  id uuid PRIMARY KEY,
  trade_id uuid NOT NULL REFERENCES ledger_trades(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  net_total_cents bigint NOT NULL CHECK (net_total_cents >= 0 AND net_total_cents <= 9007199254740991),
  sold_at timestamptz NOT NULL,
  received_at timestamptz,
  note text NOT NULL DEFAULT '',
  voided boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  request_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (received_at IS NULL OR received_at >= sold_at)
);
CREATE INDEX IF NOT EXISTS ledger_settlements_trade ON ledger_settlements(trade_id);

CREATE TABLE IF NOT EXISTS ledger_wallet_events (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  kind text NOT NULL CHECK (kind IN ('opening','funding','spend')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  cash_cost_cents bigint CHECK (cash_cost_cents >= 0 AND cash_cost_cents <= 9007199254740991),
  occurred_at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  voided boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  request_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger_refunds (
  id uuid PRIMARY KEY,
  trade_id uuid NOT NULL REFERENCES ledger_trades(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 9007199254740991),
  occurred_at timestamptz NOT NULL,
  note text NOT NULL DEFAULT '',
  request_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger_price_snapshots (
  id uuid PRIMARY KEY,
  appid integer NOT NULL CHECK (appid IN (730,570)),
  market_hash_name text NOT NULL,
  observed_at timestamptz NOT NULL,
  buff_price_cents bigint CHECK (buff_price_cents >= 0),
  steam_price_cents bigint CHECK (steam_price_cents >= 0),
  buff_net_cents bigint CHECK (buff_net_cents >= 0),
  steam_net_cents bigint CHECK (steam_net_cents >= 0),
  source text NOT NULL,
  request_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ledger_prices_item_time ON ledger_price_snapshots(appid,market_hash_name,observed_at DESC);
CREATE TABLE IF NOT EXISTS ledger_purchase_tasks (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES ledger_accounts(id),
  platform text NOT NULL CHECK (platform IN ('buff','steam')),
  state text NOT NULL,
  request_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_active_task ON ledger_purchase_tasks(account_id,platform)
  WHERE state IN ('executing','awaiting_user','reconciling');
CREATE TABLE IF NOT EXISTS ledger_audit (
  id bigserial PRIMARY KEY,
  entity_id text NOT NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_audit_entity ON ledger_audit(entity_id,created_at);
CREATE TABLE IF NOT EXISTS ledger_meta (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO ledger_meta VALUES ('schemaVersion','1') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ledger_sale_imports (
  source_key text PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('buff','steam')),
  original jsonb NOT NULL,
  reviewed jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ledger_settlements ADD COLUMN IF NOT EXISTS external_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_settlement_external ON ledger_settlements(external_key) WHERE external_key IS NOT NULL;

-- Durable purchase execution. Leases fence stale workers; pending native clicks survive restarts.
ALTER TABLE ledger_purchase_tasks ADD COLUMN IF NOT EXISTS platform_account_id text;
ALTER TABLE ledger_purchase_tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE ledger_purchase_tasks ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE ledger_purchase_tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE ledger_purchase_tasks ADD COLUMN IF NOT EXISTS stop_requested boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS ledger_purchase_receipts (
  task_id uuid NOT NULL REFERENCES ledger_purchase_tasks(id),
  platform text NOT NULL,
  platform_account_id text NOT NULL,
  fill_id text NOT NULL,
  trade_id uuid NOT NULL REFERENCES ledger_trades(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(platform,platform_account_id,fill_id)
);

-- Import evidence is written only after the user reviews and selects buy-history rows.
CREATE TABLE IF NOT EXISTS ledger_buy_imports (
  source_key text PRIMARY KEY,
  trade_id uuid NOT NULL REFERENCES ledger_trades(id),
  platform_account_id text,
  original jsonb NOT NULL,
  reviewed jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Analysis archives are evidence only, independent of confirmed ledger transactions.
CREATE TABLE IF NOT EXISTS desktop_history_records (
  kind text NOT NULL CHECK (kind IN ('buff','csv')),
  key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind,key)
);
CREATE TABLE IF NOT EXISTS desktop_history_state (
  kind text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS desktop_history_names (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS desktop_history_imports (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

-- Desktop 0.6: archive UU history independently from confirmed ledger transactions.
ALTER TABLE desktop_history_records DROP CONSTRAINT IF EXISTS desktop_history_records_kind_check;
ALTER TABLE desktop_history_records ADD CONSTRAINT desktop_history_records_kind_check CHECK (kind IN ('buff','csv','uu','steam'));
