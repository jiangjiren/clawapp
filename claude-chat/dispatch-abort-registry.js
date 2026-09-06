/** Track provider dispatches by owning conversation so Stop stays scoped. */
export class DispatchAbortRegistry {
  constructor() {
    this._owners = new Map();
  }

  add(controller, conversationId) {
    if (!controller || typeof controller.abort !== "function") return;
    this._owners.set(controller, String(conversationId ?? "").trim() || null);
  }

  delete(controller) {
    return this._owners.delete(controller);
  }

  abortConversation(conversationId) {
    const owner = String(conversationId ?? "").trim() || null;
    for (const [controller, controllerOwner] of [...this._owners]) {
      if (controllerOwner !== owner) continue;
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }

  abortAll() {
    for (const controller of [...this._owners.keys()]) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
  }
}
