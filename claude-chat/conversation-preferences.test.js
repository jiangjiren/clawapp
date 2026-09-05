import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Run the shipped preference/model functions without network or SDK side effects.
// DOM sinks are stubs; actual browser interactions are verified separately.
const html = readFileSync(new URL("public/index.html", import.meta.url), "utf8");
const prefsSource = html.slice(html.indexOf("// Account/model/effort"), html.indexOf("// ── 游标同步状态"));
const modelsSource = html.slice(html.indexOf("const CLAUDE_MODELS ="), html.indexOf("let _profileData ="));
function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return html.slice(start, html.indexOf("\n}", start) + 2);
}
const profiles = [
  { id: "claude", provider: "claude", name: "Claude" },
  { id: "codex", provider: "codex", name: "Codex", sonnetModel: "gpt-5.6-terra" },
  { id: "custom", provider: "custom", name: "Custom", sonnetModel: "custom-model" },
  { id: "agy", provider: "antigravity", name: "Antigravity" },
];

function harness(saved = {}) {
  const storage = new Map(Object.entries(saved));
  const sink = { innerHTML: "", textContent: "", querySelector() { return this; } };
  const ctx = vm.createContext({
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    modelDropdown: sink, modelLabel: sink, authProfileList: sink,
    escapeHtml: String, escapeAttr: String, providerBadge: () => "", renderProviderLimitSummary: () => "",
    requestSkillRefresh() {}, updateEffortDisplay() {}, resetCursor() {},
    genId: (() => { let id = 0; return () => `draft-${++id}`; })(),
  });
  vm.runInContext(`
    let currentConvId = null, selectedModel = "claude-sonnet-5", selectedEffort = "medium";
    let _profileData = { activeProfileId: "claude", profiles: [] };
    let _claudeAuthStatus = null, _codexAuthStatus = null;
    ${prefsSource}
    ${modelsSource}
    ${["getActiveProfile", "renderProfileList", "renderModelOptions"].map(functionSource).join("\n")}
  `, ctx);
  return {
    storage,
    run: code => vm.runInContext(code, ctx),
    state: () => JSON.parse(vm.runInContext('JSON.stringify({ profile: getActiveProfile()?.id, model: selectedModel, effort: selectedEffort })', ctx)),
    loadProfiles: () => vm.runInContext(`renderProfileList({activeProfileId:"claude",profiles:${JSON.stringify(profiles)}})`, ctx),
  };
}

test("cold start can render models before profiles are loaded", () => {
  const h = harness();
  assert.doesNotThrow(() => h.run("renderProfileList(_profileData)"));
  h.loadProfiles();
  assert.equal(h.state().model, "claude-sonnet-5");
});

test("Antigravity conversation preferences survive polling and retain supported older models", () => {
  const h = harness();
  h.loadProfiles();
  h.run('currentConvId="agy-conv";selectConversationProfile("agy");selectedEffort="max";rememberConvModelPrefs()');
  h.loadProfiles();
  assert.deepEqual(h.state(), { profile: "agy", model: "gemini-3.1-pro", effort: "max" });
  h.run('_agyStatus.efforts={"gemini-3.7-flash":["low","high"]};selectedModel="gemini-3.7-flash";rememberConvModelPrefs()');
  h.loadProfiles();
  assert.equal(h.state().model, "gemini-3.7-flash");
  h.run('currentConvId="claude-conv";applyConvModelPrefs({profileId:"claude"})');
  assert.equal(h.state().profile, "claude");
  h.run('currentConvId="agy-conv";applyConvModelPrefs({profileId:"agy",sessionProvider:"antigravity"})');
  assert.equal(h.state().model, "gemini-3.7-flash");
});

test("conversation choices survive switching, polling and a fresh page without rewriting defaults", () => {
  const h = harness({ effort: "medium", activeProfileId: "claude", "model:claude": "claude-sonnet-5" });
  h.loadProfiles();
  h.run('currentConvId="a";selectedModel="claude-opus-5";selectedEffort="high";rememberConvModelPrefs()');
  h.run('currentConvId="b";selectConversationProfile("codex");selectedModel="gpt-6-astra";selectedEffort="xhigh";rememberConvModelPrefs()');
  h.run('currentConvId="a";applyConvModelPrefs({id:"a",profileId:"claude"})');
  assert.deepEqual(h.state(), { profile: "claude", model: "claude-opus-5", effort: "high" });
  h.loadProfiles();
  assert.deepEqual(h.state(), { profile: "claude", model: "claude-opus-5", effort: "high" });
  h.run('currentConvId="b";applyConvModelPrefs({id:"b",profileId:"codex"})');
  assert.deepEqual(h.state(), { profile: "codex", model: "gpt-6-astra", effort: "xhigh" });
  assert.equal(h.storage.get("effort"), "medium");
  assert.equal(h.storage.get("activeProfileId"), "claude");
  assert.equal(h.storage.get("model:claude"), "claude-sonnet-5");
  const reload = harness(Object.fromEntries(h.storage));
  reload.loadProfiles();
  reload.run('currentConvId="b";applyConvModelPrefs()');
  assert.deepEqual(reload.state(), h.state());
});

test("first-message draft settings are remembered and removed accounts safely fall back", () => {
  const h = harness();
  h.loadProfiles();
  h.run('selectedEffort="max";rememberConvModelPrefs({create:true});selectConversationProfile("custom")');
  assert.deepEqual(h.state(), { profile: "custom", model: "custom-model", effort: "max" });
  h.run('forgetProfileFromConvPrefs("custom");_profileData.profiles=_profileData.profiles.filter(p=>p.id!=="custom");applyConvModelPrefs()');
  assert.deepEqual(h.state(), { profile: "claude", model: "claude-sonnet-5", effort: "max" });
});

test("legacy histories retain their provider/model and malformed preference storage is ignored", () => {
  for (const saved of ["{broken", '{"unexpected":true}', '[null,["a",null],["b",4]]']) {
    const h = harness({ "convModelPrefs-v1": saved });
    h.loadProfiles();
    h.run('currentConvId="old";applyConvModelPrefs({sessionProvider:"codex",model:"gpt-5.6-luna",effort:"high"})');
    assert.deepEqual(h.state(), { profile: "codex", model: "gpt-5.6-luna", effort: "high" });
  }
});
