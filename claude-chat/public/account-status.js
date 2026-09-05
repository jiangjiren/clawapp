function accountStatus(profile, { claudeAuth, codexAuth, agy = {}, limits = {} }) {
  const provider = profile.provider;
  const limit = limits[provider] || {};
  const planNames = { free: "Free", plus: "Plus", pro: "Pro", max_5x: "Max 5x", max_20x: "Max 20x", team: "Team", business: "Business", enterprise: "Enterprise" };
  const plan = limit.planType || limit.subscriptionType;
  const suffix = plan ? ` · ${planNames[String(plan).toLowerCase()] || String(plan)}` : "";
  if (provider === "antigravity") return {
    tone: agy.ready ? "ok" : agy.installed === false ? "warn" : "muted",
    text: agy.ready ? "CLI 可用" : agy.installed === false ? "尚未安装 CLI" : "CLI 待就绪",
    detail: agy.message || "正在检测 Antigravity CLI",
  };
  if (provider === "claude" || provider === "codex") {
    if (limit.status === "expired") return { tone: "warn", text: "登录已失效", detail: "请在服务器重新登录此账号" };
    const auth = provider === "claude" ? claudeAuth : codexAuth;
    if (auth === null || auth === undefined) return { tone: "muted", text: "正在检测登录", detail: "正在读取本机登录状态" };
    if (!auth) return { tone: "warn", text: "未检测到登录", detail: `请在服务器运行 ${provider === "claude" ? "claude" : "codex login"} 完成登录` };
    return { tone: "ok", text: `已登录${suffix}`, detail: limit.status === "error" ? "额度查询暂时失败，可稍后重试" : "使用服务器上的 CLI 账号" };
  }
  return { tone: profile.maskedApiKey ? "ok" : "warn", text: profile.maskedApiKey ? "密钥已配置" : "未配置密钥", detail: [profile.maskedApiKey, profile.sonnetModel || profile.opusModel].filter(Boolean).join(" · ") };
}
