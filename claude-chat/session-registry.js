/**
 * ══════════════════════════════════════════════════════════════════════
 * SessionRegistry —— 多个对话同时活着
 * ══════════════════════════════════════════════════════════════════════
 *
 * 每个对话一个 ConversationSession。「当前是哪个」不靠猜，由调用方给的
 * resolveCurrentId 决定——在 server.js 里那是 AsyncLocalStorage，绑在事件泵
 * 和客户端消息处理上，跟着异步流走。
 *
 * 两条边界要分清：
 *   - 活着（tracked）：内存里有状态的对话，切走了也留着，回来能接上
 *   - 在跑（busy）：真的有 agent 在干活。并发上限限的是这个，不是前者
 *
 * 上限之所以必要：每个在跑的会话是一个真实的 SDK 子进程 + 一份 token 消耗。
 * 不设限不是「不限制」，是把撞墙的时机交给运气。
 */

export class SessionRegistry {
  /**
   * @param {object} options
   * @param {number} options.limit          同时在跑的会话上限
   * @param {function} options.createSession 造一个新的 ConversationSession
   * @param {function} options.resolveCurrentId 当前上下文属于哪个对话（可返回 null）
   * @param {function} options.isBusy       判断某个 session 是否还在干活
   * @param {number} [options.maxTracked]   内存里最多留几个对话的状态
   */
  constructor({ limit = 10, createSession, resolveCurrentId, isBusy, maxTracked = 50 } = {}) {
    if (typeof createSession !== "function") throw new TypeError("createSession is required");
    if (typeof resolveCurrentId !== "function") throw new TypeError("resolveCurrentId is required");
    if (typeof isBusy !== "function") throw new TypeError("isBusy is required");
    this.limit = limit;
    this.maxTracked = maxTracked;
    this._createSession = createSession;
    this._resolveCurrentId = resolveCurrentId;
    this._isBusy = isBusy;
    this._sessions = new Map();      // conversationId -> session
    this._touchedAt = new Map();     // conversationId -> 上次用到的时间
    /* 还没关联到具体对话时落在这儿：进程刚起来、从磁盘恢复上次的 sessionId，
       那时还不知道属于哪个对话。前端一旦发来带 conversationId 的消息就会路由
       到真正的实例，所以这个只是兜底，不参与并发计数。 */
    this.ambient = createSession(null);
  }

  /** 当前上下文所属的 session；没有上下文时给 ambient。 */
  current() {
    const id = this._resolveCurrentId();
    return id ? this.acquire(id) : this.ambient;
  }

  /** 拿到某个对话的 session，没有就建一个。 */
  acquire(conversationId) {
    const id = String(conversationId ?? "").trim();
    if (!id) return this.ambient;
    let s = this._sessions.get(id);
    const isNew = !s;
    if (isNew) {
      s = this._createSession(id);
      this._sessions.set(id, s);
    }
    // 必须先记上时间再回收：否则新建的这个 touchedAt 还是空的，
    // 排序时排在「最久没碰」的第一位，刚建出来就被自己触发的回收删掉
    this._touchedAt.set(id, Date.now());
    if (isNew) this._evictIdle();
    return s;
  }

  /** 只看有没有，不创建。 */
  peek(conversationId) {
    const id = String(conversationId ?? "").trim();
    return id ? (this._sessions.get(id) ?? null) : this.ambient;
  }

  /** 正在干活的对话 id。 */
  runningIds() {
    const out = [];
    for (const [id, s] of this._sessions) {
      if (this._isBusy(s)) out.push(id);
    }
    return out;
  }

  get runningCount() {
    return this.runningIds().length;
  }

  get trackedCount() {
    return this._sessions.size;
  }

  /**
   * 这个对话现在可以开跑吗。
   * 已经在跑的那个再发一条消息不占新名额——那是同一个会话的下一轮，
   * 不是又开了一个。
   */
  canRun(conversationId) {
    const id = String(conversationId ?? "").trim();
    const running = this.runningIds();
    if (id && running.includes(id)) return true;
    return running.length < this.limit;
  }

  /** 明确丢弃一个对话的状态（用户删除会话等）。 */
  drop(conversationId) {
    const id = String(conversationId ?? "").trim();
    if (!id) return false;
    this._touchedAt.delete(id);
    return this._sessions.delete(id);
  }

  /** 内存里留太多空闲对话时，按最久没碰过的顺序丢掉——在跑的绝不动。 */
  _evictIdle() {
    if (this._sessions.size <= this.maxTracked) return;
    const idle = [...this._sessions.entries()]
      .filter(([, s]) => !this._isBusy(s))
      .map(([id]) => id)
      .sort((a, b) => (this._touchedAt.get(a) ?? 0) - (this._touchedAt.get(b) ?? 0));
    for (const id of idle) {
      if (this._sessions.size <= this.maxTracked) break;
      this._sessions.delete(id);
      this._touchedAt.delete(id);
    }
  }
}
