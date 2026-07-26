import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_DEFAULT_MODEL,
  buildModelCandidates,
  isCandidateUnavailableError,
  runWithModelFallback,
} from "./model-fallback.js";

const profiles = {
  activeProfileId: "p_claude",
  profiles: [
    { id: "p_claude", name: "Claude 会员", provider: "claude", apiKey: "", baseUrl: "" },
    { id: "p_codex", name: "Codex", provider: "codex", sonnetModel: "gpt-main", opusModel: "gpt-strong", haikuModel: "gpt-fast" },
    { id: "p_deepseek", name: "DeepSeek", provider: "deepseek", apiKey: "key", baseUrl: "https://example.test", sonnetModel: "deepseek-pro", opusModel: "deepseek-pro", haikuModel: "deepseek-fast" },
    { id: "p_broken", name: "Broken", provider: "custom", apiKey: "", baseUrl: "https://example.test", sonnetModel: "ignored" },
  ],
};

test("buildModelCandidates uses Sonnet 5 first and reads configured models dynamically", () => {
  assert.deepEqual(buildModelCandidates(profiles), [
    { profileId: "p_claude", profileName: "Claude 会员", provider: "claude", model: CHANNEL_DEFAULT_MODEL },
    { profileId: "p_codex", profileName: "Codex", provider: "codex", model: "gpt-main" },
    { profileId: "p_codex", profileName: "Codex", provider: "codex", model: "gpt-strong" },
    { profileId: "p_codex", profileName: "Codex", provider: "codex", model: "gpt-fast" },
    { profileId: "p_deepseek", profileName: "DeepSeek", provider: "deepseek", model: "deepseek-pro" },
    { profileId: "p_deepseek", profileName: "DeepSeek", provider: "deepseek", model: "deepseek-fast" },
  ]);
});

test("buildModelCandidates can omit providers that cannot support required tools", () => {
  assert.equal(buildModelCandidates(profiles, { excludedProviders: ["codex"] })[1].provider, "deepseek");
});

test("buildModelCandidates accepts an official Anthropic API profile without a custom base URL", () => {
  const data = {
    profiles: [
      profiles.profiles[0],
      { id: "p_anthropic", name: "Anthropic API", provider: "anthropic", apiKey: "key", sonnetModel: "claude-api-model" },
    ],
  };
  assert.equal(buildModelCandidates(data)[1].model, "claude-api-model");
});

test("unavailable-candidate errors are classified narrowly", () => {
  assert.equal(isCandidateUnavailableError(new Error("API Error: Fable 5 requires usage credits")), true);
  assert.equal(isCandidateUnavailableError(new Error("Unknown model claude-retired")), true);
  assert.equal(isCandidateUnavailableError(new Error("OAuth token expired: unauthorized")), true);
  assert.equal(isCandidateUnavailableError(new Error("Failed to write report.md")), false);
});

test("runWithModelFallback retries configured candidates after a model availability error", async () => {
  const candidates = buildModelCandidates(profiles).slice(0, 3);
  const attempted = [];
  const result = await runWithModelFallback(candidates, async candidate => {
    attempted.push(candidate.model);
    if (attempted.length === 1) throw new Error("model not available");
    return candidate.model;
  }, { logger: { warn() {} } });

  assert.equal(result, "gpt-main");
  assert.deepEqual(attempted, [CHANNEL_DEFAULT_MODEL, "gpt-main"]);
});

// 会员登录过期是无人值守渠道最常见的故障，必须能从第一个候选降级出去
test("runWithModelFallback falls back when the first candidate's credentials expired", async () => {
  const candidates = buildModelCandidates(profiles).slice(0, 2);
  const attempted = [];
  const result = await runWithModelFallback(candidates, async candidate => {
    attempted.push(candidate.model);
    if (attempted.length === 1) throw new Error("Failed to authenticate: OAuth token has expired");
    return candidate.model;
  }, { logger: { warn() {} } });

  assert.equal(result, "gpt-main");
  assert.deepEqual(attempted, [CHANNEL_DEFAULT_MODEL, "gpt-main"]);
});

test("runWithModelFallback does not retry task errors", async () => {
  const candidates = buildModelCandidates(profiles).slice(0, 2);
  let attempts = 0;
  await assert.rejects(
    runWithModelFallback(candidates, async () => {
      attempts++;
      throw new Error("permission denied while writing a note");
    }, { logger: { warn() {} } }),
    /permission denied while writing a note/
  );
  assert.equal(attempts, 1);
});
