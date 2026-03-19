// ---------------------------------------------------------------------------
// Per-sender and per-chat project context with a 10-minute TTL.
//
// When a user sends a text message that mentions a project, the resolver
// stores that context here so subsequent attachments are automatically
// routed to the same project — without requiring an explicit tag on every
// message.
//
// Chat-level context covers all participants in the chat so that a file
// sent by one participant can be resolved via a project message sent by
// another participant in the same chat.
// ---------------------------------------------------------------------------

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface SenderContext {
  readonly projectName: string;
  /** Full original message text — reused by AI classification and naming. */
  readonly rawMessageText: string;
  /** Optional location keyword extracted from the message (e.g. "bathroom"). */
  readonly locationHint?: string;
  /** Optional description keyword extracted from the message (e.g. "tile work"). */
  readonly descriptionHint?: string;
  readonly setAtMs: number;
}

export interface ChatContext {
  /**
   * Pre-resolved project name (validated against known projects).
   * null when the context is a raw hint only — not yet matched to a project.
   * The AI uses the rawMessageText in either case.
   */
  readonly projectName: string | null;
  /** Most recent raw message text — kept for backward compat. */
  readonly rawMessageText: string;
  /**
   * Rolling window of up to 5 recent unresolved messages, oldest first.
   * AI receives all of these so an earlier "Office Orange County" is not
   * lost when a later "hey" message overwrites the single-text hint.
   */
  readonly rawMessages: readonly string[];
  readonly setAtMs: number;
}

export class UserContextStore {
  private readonly senderStore = new Map<string, SenderContext>();
  private readonly chatStore = new Map<number, ChatContext>();

  // ---- Sender-level context ----

  set(
    senderId: string,
    projectName: string,
    rawMessageText: string,
    hints?: { locationHint?: string; descriptionHint?: string },
  ): void {
    this.senderStore.set(senderId, {
      projectName,
      rawMessageText,
      ...(hints?.locationHint !== undefined
        ? { locationHint: hints.locationHint }
        : {}),
      ...(hints?.descriptionHint !== undefined
        ? { descriptionHint: hints.descriptionHint }
        : {}),
      setAtMs: Date.now(),
    });
  }

  get(senderId: string): SenderContext | null {
    const entry = this.senderStore.get(senderId);
    if (!entry) return null;
    if (Date.now() - entry.setAtMs > TTL_MS) {
      this.senderStore.delete(senderId);
      return null;
    }
    return entry;
  }

  invalidate(senderId: string): void {
    this.senderStore.delete(senderId);
  }

  // ---- Chat-level context ----

  /**
   * Store a resolved project as strong chat context.
   * Always overwrites any existing hint.
   */
  setChat(chatId: number, projectName: string, rawMessageText: string): void {
    this.chatStore.set(chatId, {
      projectName,
      rawMessageText,
      rawMessages: [],
      setAtMs: Date.now(),
    });
  }

  /**
   * Store raw message text as a weak hint for AI context.
   * Only written when there is no existing non-expired resolved context —
   * a pre-resolved project is never overwritten by a raw hint.
   */
  setChatHint(chatId: number, rawText: string): void {
    const existing = this.chatStore.get(chatId);
    if (
      existing?.projectName != null &&
      Date.now() - existing.setAtMs <= TTL_MS
    ) {
      return; // resolved context still valid — don't downgrade to a raw hint
    }

    // Accumulate up to 5 recent messages (oldest first) rather than replacing,
    // so that "Office Orange County" sent before "hey" is not lost.
    const existingMessages: readonly string[] =
      existing != null && Date.now() - existing.setAtMs <= TTL_MS
        ? existing.rawMessages
        : [];
    const rawMessages = [...existingMessages, rawText].slice(-5);

    this.chatStore.set(chatId, {
      projectName: null,
      rawMessageText: rawText,
      rawMessages,
      setAtMs: Date.now(),
    });
  }

  getChat(chatId: number): ChatContext | null {
    const entry = this.chatStore.get(chatId);
    if (!entry) return null;
    if (Date.now() - entry.setAtMs > TTL_MS) {
      this.chatStore.delete(chatId);
      return null;
    }
    return entry;
  }
}
