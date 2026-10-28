-- Only this dedicated application's schema. No existing business tables are touched.
CREATE SCHEMA IF NOT EXISTS buff_cloud;
CREATE TABLE IF NOT EXISTS buff_cloud.profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  device_id text,
  sequence bigint NOT NULL DEFAULT 0,
  content_hash text,
  snapshot jsonb,
  collected_at timestamptz,
  uploaded_at timestamptz
);
CREATE TABLE IF NOT EXISTS buff_cloud.bindings (
  platform text NOT NULL CHECK (platform IN ('buff','uu','steam','csv')),
  account_id text NOT NULL,
  profile_id text NOT NULL REFERENCES buff_cloud.profiles(id),
  PRIMARY KEY (platform, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS buff_cloud_one_platform_per_profile
  ON buff_cloud.bindings(profile_id,platform) WHERE platform <> 'csv';
CREATE TABLE IF NOT EXISTS buff_cloud.sync_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id text NOT NULL REFERENCES buff_cloud.profiles(id),
  device_id text NOT NULL,
  sequence bigint NOT NULL,
  content_hash text NOT NULL,
  record_count integer NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id,device_id,sequence)
);
