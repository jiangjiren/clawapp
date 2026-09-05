// Pending messages belong to a conversation and a browser tab. Only a dispatched
// message enters server history; its stable ID makes retries idempotent.
class PendingMessageQueue extends Map {
  constructor(storage, onChange = () => {}) {
    super();
    this.storage = storage;
    this.onChange = onChange;
    try {
      const entries = JSON.parse(storage.getItem("pending-messages-v1") || "[]");
      for (const [id, value] of entries) {
        if (typeof id === "string" && value?.userMessageId === id && typeof value.conversationId === "string" && typeof value.prompt === "string") super.set(id, value);
      }
    } catch { /* Missing or corrupt tab storage. */ }
  }
  changed() {
    try { this.storage.setItem("pending-messages-v1", JSON.stringify([...this])); }
    catch { this.onChange("队列较大，刷新页面可能丢失待发送消息。"); return; }
    this.onChange();
  }
  set(id, value) { super.set(id, value); this.changed(); return this; }
  delete(id) { const result = super.delete(id); if (result) this.changed(); return result; }
  clear() { super.clear(); this.changed(); }
  forConversation(id) { return [...this].filter(([, item]) => item.conversationId === id); }
  clearConversation(id) { for (const [key] of this.forConversation(id)) super.delete(key); this.changed(); }
  move(id, offset) {
    const item = this.get(id);
    if (!item || item.queueState === "sending") return;
    const entries = this.forConversation(item.conversationId);
    const from = entries.findIndex(([key]) => key === id), to = from + offset;
    if (to < 0 || to >= entries.length || entries[to][1].queueState === "sending") return;
    [entries[from], entries[to]] = [entries[to], entries[from]];
    for (const [key] of entries) super.delete(key);
    for (const [key, value] of entries) super.set(key, value);
    this.changed();
  }
  edit(id, text) {
    const item = this.get(id);
    text = String(text).trim();
    if (!item || item.queueState === "sending" || !text) return false;
    this.set(id, { ...item, composerText: text, displayText: text + (item.displaySuffix || ""), prompt: [...(item.contextParts || []), text].join("\n\n") });
    return true;
  }
}
