(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const card = $("accountCloudCard");
  if (!card || !window.buffDesktop) return;
  const platformNames = { buff: "BUFF", uu: "悠悠", steam: "Steam" };
  const api = (action, payload = {}) => window.buffDesktop.request(action, payload);
  let current = null, busy = false, renameDirty = false, requestVersion = 0, refreshQueued = false;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function time(value) {
    if (value == null || value === "") return "尚无记录";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "尚无记录";
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) + "（北京时间）";
  }
  function selected() { return current?.profiles?.find(item => item.id === current.activeProfileId) || null; }
  function setControls() {
    const profile = selected(), cloud = current?.cloud || {}, locked = busy || cloud.running;
    $("terminalProfile").disabled = Boolean(locked || !current);
    $("terminalProfileApply").disabled = Boolean(locked || !$("terminalProfile").value || $("terminalProfile").value === current?.activeProfileId);
    $("terminalProfileName").disabled = Boolean(locked || !profile);
    $("terminalProfileRename").disabled = Boolean(locked || !profile || !$("terminalProfileName").value.trim());
    $("terminalProfileAdopt").disabled = Boolean(locked || !profile);
    $("terminalCloudImport").disabled = Boolean(locked || !profile || cloud.enabled === false);
    const canUseCloud = !locked && profile && cloud.enabled !== false && cloud.configured && cloud.profileId === profile.id;
    $("terminalCloudUpload").disabled = !canUseCloud;
    $("terminalMobileExport").disabled = !canUseCloud;
    card.setAttribute("aria-busy", String(Boolean(busy)));
  }
  function showError(error) {
    $("accountCloudError").textContent = error?.message || "操作失败，请稍后重试";
    $("accountCloudError").hidden = false;
    $("accountCloudMessage").textContent = "";
  }
  function render(value) {
    const previousId = current?.activeProfileId, previousDraft = $("terminalProfile").value;
    current = value;
    const profile = selected(), changed = previousId !== current.activeProfileId;
    const placeholder = node("option", "请选择账户"); placeholder.value = ""; placeholder.disabled = true;
    $("terminalProfile").replaceChildren(placeholder, ...(current.profiles || []).map(item => {
      const option = node("option", item.name); option.value = item.id; return option;
    }));
    $("terminalProfile").value = changed || !previousDraft ? current.activeProfileId || "" : previousDraft;
    $("terminalProfileSummary").textContent = profile ? `本机：${profile.name}` : "本机尚未关联账户";
    if ($("activeProfileLabel")) $("activeProfileLabel").textContent = profile?.name || "关联账户";
    $("terminalProfileApply").textContent = profile ? "切换关联账户" : "关联此终端";
    if (changed || !renameDirty) { $("terminalProfileName").value = profile?.name || ""; renameDirty = false; }
    const states = current.currentPlatformStates || current.platforms || {};
    $("terminalPlatformBindings").replaceChildren(...Object.entries(platformNames).map(([platform, label]) => {
      const binding = profile?.bindings?.[platform], state = states[platform] || {};
      const attention = state.needsLogin || ["login-required", "account-mismatch"].includes(state.phase);
      const item = node("div", null, "account-cloud-binding" + (attention ? " needs-attention" : ""));
      if (window.LedgerBrand) item.append(window.LedgerBrand.platformLogo(platform));
      item.append(node("strong", label), node("small", binding ? `已关联：${binding}` : "尚未关联平台账号"));
      item.append(node("small", attention ? state.message || "登录认证失效，请重新登录并检查" : binding ? state.message || "等待同步" : "登录并检查账号后建立关联"));
      const go = node("button", attention ? "重新登录 / 检查 →" : "管理登录 →", "text-button");
      go.type = "button"; go.disabled = !profile;
      go.onclick = () => window.BuffDesktopNavigation?.navigate(platform === "buff" ? "orders" : platform);
      item.append(go); return item;
    }));
    const schedule = current.schedule || {}, cloud = current.cloud || {};
    $("terminalSchedule").textContent = !profile ? "关联账户后开始" : schedule.enabled === false ? "自动同步已关闭" : schedule.status === "running" ? "正在同步；下次 " + time(schedule.nextRunAt) : schedule.nextRunAt ? "下次 " + time(schedule.nextRunAt) : "每 6 小时一次，等待启动";
    const cloudNames = { unconfigured: "尚未导入终端连接文件", idle: "已配置，等待数据更新", pending: "有记录等待上传", uploading: "正在上传", syncing: "正在上传", synced: "已上传", completed: "已上传", attention: "需要处理后继续", "account-mismatch": "云端连接与本机账户不一致", retrying: "连接暂不可用，等待重试", failed: "上传未完成" };
    $("terminalCloudStatus").textContent = cloud.enabled === false ? "当前模式未启用云端同步" : !cloud.configured ? cloudNames.unconfigured : cloud.running ? "正在上传" : cloudNames[cloud.status] || (cloud.pending ? "有记录等待上传" : "已配置");
    $("terminalLastUpload").textContent = cloud.lastUploadedAt ? time(cloud.lastUploadedAt) : "尚未上传";
    const attention = [cloud.error, schedule.lastError].filter(Boolean);
    if (Object.values(states).some(item => item.needsLogin)) attention.push("部分平台认证需要处理：请进入对应平台重新登录并检查，其他平台继续同步。");
    $("terminalAccountAttention").textContent = attention.join(" "); $("terminalAccountAttention").hidden = !attention.length;
    if ($("overviewAccountStatus")) $("overviewAccountStatus").textContent = attention.length ? attention.join(" ") : profile ? `${profile.name} · ${$("terminalSchedule").textContent} · ${$("terminalCloudStatus").textContent}` : "关联本机账户，开始汇总三个平台的交易记录。";
    $("overviewAccountContext")?.classList.toggle("needs-attention", Boolean(attention.length));
    setControls();
  }
  async function refresh() {
    const version = ++requestVersion;
    const value = await api("profiles:status");
    if (version === requestVersion) render(value);
    return value;
  }
  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; void refresh().catch(showError); });
  }
  async function action(request, success) {
    if (busy) return;
    busy = true; setControls(); $("accountCloudError").hidden = true; $("accountCloudMessage").textContent = "正在处理…";
    try {
      const result = await request();
      if (result?.cancelled || result?.canceled) { $("accountCloudMessage").textContent = "已取消，配置保持不变"; return; }
      await refresh();
      $("accountCloudMessage").textContent = typeof success === "function" ? success(result) : success;
    } catch (error) { showError(error); }
    finally { busy = false; setControls(); }
  }
  $("terminalProfile").onchange = () => { $("terminalProfile").removeAttribute("aria-invalid"); setControls(); };
  $("terminalProfile").addEventListener("invalid", () => $("terminalProfile").setAttribute("aria-invalid", "true"));
  $("terminalProfileForm").onsubmit = event => {
    event.preventDefault();
    if (!$("terminalProfileForm").reportValidity() || $("terminalProfileApply").disabled) return;
    const profileId = $("terminalProfile").value;
    void action(() => api("profiles:select", { profileId }), "终端账户已关联，正在载入该账户记录…");
  };
  $("terminalProfileName").oninput = () => { renameDirty = true; setControls(); };
  $("terminalProfileRenameForm").onsubmit = event => {
    event.preventDefault();
    if (!$("terminalProfileRenameForm").reportValidity() || $("terminalProfileRename").disabled) return;
    const profileId = current.activeProfileId, name = $("terminalProfileName").value.trim();
    void action(async () => { const result = await api("profiles:rename", { profileId, name }); renameDirty = false; return result; }, "账户名称已保存");
  };
  $("terminalProfileAdopt").onclick = () => action(() => api("profiles:adopt"), "本机已有记录已关联当前账户");
  $("terminalCloudImport").onclick = () => action(() => api("cloud:import"), "终端连接文件已导入");
  $("terminalCloudUpload").onclick = () => action(() => api("cloud:upload"), result => result?.status === "synced" && !result.pending && !result.error ? "当前账户记录已上传云端" : "上传尚未完成，请查看云端状态");
  $("terminalMobileExport").onclick = () => action(() => api("cloud:export-mobile"), "手机连接文件已保存，请在 iOS App 中导入");
  window.buffDesktop.onChange(event => {
    if (["account-runtime", "sync-schedule", "account-profiles", "cloud-sync"].includes(event.kind)) queueRefresh();
  });
  const ready = refresh().catch(showError);
  window.BuffAccountCloudWorkspace = { ready, refresh };
})();
