#!/usr/bin/env node
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const crypto=require("node:crypto");
const {spawn,spawnSync}=require("node:child_process");
const {Client}=require("pg");
const root=path.resolve(__dirname,".."), directory=path.join(root,".ledger"), configFile=path.join(directory,"config.json");
const launchFile=path.join(os.homedir(),"Library/LaunchAgents/com.buff-goods.ledger.plist");
const read=()=>JSON.parse(fs.readFileSync(configFile,"utf8"));
async function health() {
  const config=read();
  const response=await fetch(`http://127.0.0.1:${config.port}/v1/health`,{headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(3000)});
  const body=await response.json(); if(!body.ok) throw new Error(body.error); return body.result;
}
async function setup() {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.chmodSync(directory,0o700);
  let config;
  if(fs.existsSync(configFile)) config=read();
  else {
    const admin=new Client({host:process.env.PGHOST || "127.0.0.1",port:Number(process.env.PGPORT || 5432),user:process.env.PGUSER || os.userInfo().username,database:"postgres",password:process.env.PGPASSWORD});
    await admin.connect();
    const exists=await admin.query("SELECT 1 FROM pg_database WHERE datname='game_asset_settle'");
    if(exists.rows.length) {await admin.end();throw new Error("game_asset_settle 已存在但缺少配置；请恢复 .ledger/config.json，避免覆盖现有数据库");}
    const password=crypto.randomBytes(32).toString("hex");
    const role=await admin.query("SELECT 1 FROM pg_roles WHERE rolname='game_asset_settle_app'");
    if(role.rows.length) {await admin.end();throw new Error("game_asset_settle_app 角色已存在，请先恢复原服务配置");}
    await admin.query(`CREATE ROLE game_asset_settle_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query("CREATE DATABASE game_asset_settle OWNER game_asset_settle_app");
    await admin.end();
    config={port:3217,token:crypto.randomBytes(32).toString("hex"),extensionOrigins:[],database:{host:process.env.PGHOST || "127.0.0.1",port:Number(process.env.PGPORT || 5432),user:"game_asset_settle_app",password,database:"game_asset_settle"}};
  }
  fs.writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});
  fs.chmodSync(configFile,0o600);
  const {Store}=require("../server/store.cjs");const store=new Store(config.database);await store.migrate();await store.close();
  console.log("本机数据库已准备好。运行 npm run desktop；首次连接选择 .ledger/config.json。无需安装 Chrome 扩展。");
}
async function main() {
  const command=process.argv[2] || "status";
  if(command==="setup") return setup();
  if(command==="status") {const h=await health();console.log(JSON.stringify({running:true,database:h.database,pid:h.pid,startedAt:h.startedAt}));return;}
  if(command==="start") {
    try {const h=await health();console.log(`服务已运行（PID ${h.pid}）`);return;} catch {}
    read();
    if(process.platform==='darwin'&&fs.existsSync(launchFile)){
      const domain=`gui/${process.getuid()}`;
      spawnSync('launchctl',['bootstrap',domain,launchFile],{stdio:'ignore'});
      spawnSync('launchctl',['kickstart',`${domain}/com.buff-goods.ledger`],{stdio:'ignore'});
      for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,200));try{const h=await health();console.log(`用户服务已启动（PID ${h.pid}）`);return;}catch{}}
      throw new Error('用户服务启动失败，请查看 .ledger/service.log');
    }
    const log=fs.openSync(path.join(directory,"service.log"),"a",0o600);
    const child=spawn(process.execPath,[path.join(root,"server/index.cjs")],{cwd:root,detached:true,stdio:["ignore",log,log]});
    child.unref();fs.closeSync(log);
    fs.writeFileSync(path.join(directory,"service.pid"),String(child.pid),{mode:0o600});
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,200));try{const h=await health();console.log(`服务已启动（PID ${h.pid}）`);return;}catch{}}
    throw new Error("服务未就绪，请查看 .ledger/service.log");
  }
  if(command==="stop") {
    let h;try{h=await health();}catch{}
    if(process.platform==='darwin'&&fs.existsSync(launchFile))spawnSync('launchctl',['bootout',`gui/${process.getuid()}/com.buff-goods.ledger`],{stdio:'ignore'});
    if(h)try{process.kill(h.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    console.log('已停止本地交易账本服务；可运行 service:start 恢复');return;
  }
  if(command==="backup") {
    const config=read(), file=path.join(directory,`backup-${new Date().toISOString().replace(/[:.]/g,"-")}.dump`);
    const p=spawnSync("pg_dump",["-Fc","-f",file,"-h",config.database.host,"-p",String(config.database.port),"-U",config.database.user,config.database.database],{env:{...process.env,PGPASSWORD:config.database.password},stdio:"inherit"});
    if(p.status!==0) throw new Error("备份失败");fs.chmodSync(file,0o600);console.log(`备份已保存：${file}`);return;
  }
  if(command==="install") {
    if(process.platform!=="darwin") throw new Error("自动启动配置仅适用于 macOS");
    read();
    const file=path.join(os.homedir(),"Library/LaunchAgents/com.buff-goods.ledger.plist");
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const xml=x=>x.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    fs.writeFileSync(file,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
      <key>Label</key><string>com.buff-goods.ledger</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(root,"server/index.cjs"))}</string></array>
      <key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
      <key>StandardOutPath</key><string>${xml(path.join(directory,"service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory,"service.log"))}</string>
      </dict></plist>`);
    try{const h=await health();process.kill(h.pid,"SIGTERM");await new Promise(r=>setTimeout(r,300));}catch{}
    spawnSync("launchctl",["bootout",`gui/${process.getuid()}/com.buff-goods.ledger`],{stdio:"ignore"});
    const p=spawnSync("launchctl",["bootstrap",`gui/${process.getuid()}`,file],{stdio:"inherit"});
    if(p.status!==0) throw new Error("自动启动配置未加载");console.log("已安装 macOS 用户登录自动启动服务");return;
  }
  throw new Error("用法：ledger-service.cjs setup|start|stop|status|install|backup");
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
