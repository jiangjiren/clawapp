export const CHANNEL_DEFAULT_MODEL = "claude-sonnet-5";

const MODEL_UNAVAILABLE_PATTERNS = [
  /requires? usage credits?/i,
  /model[^\n]*(?:not found|does not exist|unknown|unsupported|unavailable|not available)/i,
  /(?:not found|does not exist|unknown|unsupported|unavailable|not available)[^\n]*model/i,
  /(?:do not|don['’]t|does not|doesn't) have access to[^\n]*model/i,
  /(?:access|permission) (?:denied|required)[^\n]*model/i,
  /model[^\n]*(?:access|permission) (?:denied|required)/i,
  /invalid model/i,
];

const CANDIDATE_UNAVAILABLE_PATTERNS = [
  ...MODEL_UNAVAILABLE_PATTERNS,
  /failed to authenticate/i,
  /invalid authentication credentials/i,
  /invalid api key/i,
  /authentication (?:failed|required)/i,
  /unauthorized/i,
];

function errorText(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  return parts.join("\n");
}

export function isModelUnavailableError(error) {
  const text = errorText(error);
  return MODEL_UNAVAILABLE_PATTERNS.some(pattern => pattern.test(text));
}

export function isCandidateUnavailableError(error) {
  const text = errorText(error);
  return CANDIDATE_UNAVAILABLE_PATTERNS.some(pattern => pattern.test(text));
}

function isConfiguredProfile(profile) {
  if (!profile || typeof profile !== "object") return false;
  if (profile.provider === "claude" || profile.provider === "codex") return true;
  if (profile.provider === "anthropic") return Boolean(profile.apiKey);
  return Boolean(profile.apiKey && profile.baseUrl);
}

function configuredModels(profile) {
  const models = [profile.sonnetModel, profile.opusModel, profile.haikuModel]
    .map(model => typeof model === "string" ? model.trim() : "")
    .filter(Boolean);
  return [...new Set(models)];
}

/**
 * Build a fresh fallback chain from the profiles on every request/run.
 * This intentionally does not cache profile or model names, so settings changes
 * apply to the next WeChat message or scheduled job without a restart.
 */
export function buildModelCandidates(profileData, {
  defaultModel = CHANNEL_DEFAULT_MODEL,
  excludedProviders = [],
} = {}) {
  const profiles = Array.isArray(profileData?.profiles) ? profileData.profiles : [];
  const excluded = new Set(excludedProviders);
  const candidates = [];
  const seen = new Set();

  const add = (profile, model) => {
    if (!profile || excluded.has(profile.provider) || !isConfiguredProfile(profile)) return;
    const cleanModel = typeof model === "string" ? model.trim() : "";
    if (!cleanModel) return;
    const key = `${profile.id}\u0000${cleanModel}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      profileId: profile.id,
      profileName: profile.name || profile.provider,
      provider: profile.provider,
      model: cleanModel,
    });
  };

  const claudeProfile = profiles.find(profile => profile?.provider === "claude");
  add(claudeProfile, defaultModel);

  for (const profile of profiles) {
    for (const model of configuredModels(profile)) add(profile, model);
  }

  return candidates;
}

export async function runWithModelFallback(candidates, runCandidate, {
  logPrefix = "Model Fallback",
  logger = console,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("没有可用的已配置模型");
  }

  const failures = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      if (index > 0) {
        logger.warn(`[${logPrefix}] Retrying with ${candidate.profileName}/${candidate.model}`);
      }
      return await runCandidate(candidate, index);
    } catch (error) {
      failures.push({ candidate, error });
      const canRetry = index === 0
        ? isModelUnavailableError(error)
        : isCandidateUnavailableError(error);
      if (!canRetry || index === candidates.length - 1) {
        if (failures.length === 1) throw error;
        const summary = failures
          .map(({ candidate: failed, error: cause }) => `${failed.profileName}/${failed.model}: ${errorText(cause) || "未知错误"}`)
          .join("; ");
        throw new Error(`所有候选模型均不可用：${summary}`, { cause: error });
      }
      const next = candidates[index + 1];
      logger.warn(
        `[${logPrefix}] ${candidate.profileName}/${candidate.model} unavailable: ${errorText(error)}; ` +
        `falling back to ${next.profileName}/${next.model}`
      );
    }
  }

  throw new Error("没有候选模型完成请求");
}
