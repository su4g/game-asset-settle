"use strict";
// Run only against our new dedicated Docker container, never the existing DB.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const config = JSON.parse(fs.readFileSync("/etc/game-asset-settle/cloud.json", "utf8"));
if (config.database.database !== "buff_goods_cloud" || config.database.user !== "buff_cloud_app" || !/^[A-Za-z0-9_-]{32,256}$/.test(config.database.password)) throw new Error("Invalid dedicated database configuration");
const sql = `CREATE ROLE buff_cloud_app LOGIN PASSWORD '${config.database.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE buff_goods_cloud OWNER buff_cloud_app;
REVOKE ALL ON DATABASE buff_goods_cloud FROM PUBLIC;
GRANT CONNECT ON DATABASE buff_goods_cloud TO buff_cloud_app;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
`;
execFileSync("docker", ["exec", "-i", "-u", "postgres", "game-asset-settle-db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "buff_cloud_admin", "-d", "postgres"], { input: sql, stdio: ["pipe", "ignore", "ignore"] });
execFileSync("docker", ["exec", "-i", "-u", "postgres", "game-asset-settle-db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "buff_cloud_admin", "-d", "buff_goods_cloud"], { input: "REVOKE ALL ON SCHEMA public FROM PUBLIC;\n", stdio: ["pipe", "ignore", "ignore"] });
console.log("Dedicated database and least-privilege application role created.");
