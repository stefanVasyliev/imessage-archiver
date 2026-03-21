// ---------------------------------------------------------------------------
// Sender-sticky and chat-level project context.
//
// Sender context (sticky with validity window):
//   Each sender's last text message is stored indefinitely and replaced only
//   when that sender sends a new text message.  At resolution time the context
//   is treated as VALID only if the original message was sent within the last
//   SENDER_VALIDITY_WINDOW_MS (20 minutes).  This prevents stale context from
//   a different job silently routing new attachments to the wrong project.
//
// Chat context (rolling 10-minute TTL):
//   Covers all participants so that a file sent by one person can benefit from
//   a project message sent by another person in the same chat.
// ---------------------------------------------------------------------------

/** 20-minute window — sender context is valid only within this period. */
export const SENDER_VALIDITY_WINDOW_MS = 20 * 60 * 1000;

/** 10-minute TTL for chat-level context. */
const CHAT_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sender context
// ---------------------------------------------------------------------------

export interface SenderContext {
  /** Raw text of the sender's last message. */
  readonly rawMessageText: string;
  /**
   * Pre-resolved project name — present when the stored text was matched to a
   * known project folder (via tag, fuzzy match, or AI).  Absent when the text
   * was stored as a raw hint without a resolved project.
   */
  readonly projectName?: string;
  /** Optional location keyword (e.g. "bathroom") — extracted by AI. */
  readonly locationHint?: string;
  /** Optional description keyword (e.g. "tile work") — extracted by AI. */
  readonly descriptionHint?: string;
  /**
   * Millisecond timestamp of the TEXT MESSAGE itself (not the processing time).
   * Used for the 20-minute validity window — represents when the sender sent
   * the message, so a history-scan seed from 5 minutes ago stays valid even
   * after a restart.
   */
  readonly setAtMs: number;
}

// ---------------------------------------------------------------------------
// Chat context
// ---------------------------------------------------------------------------

export interface ChatContext {
  /**
   * Pre-resolved project name.  null = raw hint only; the AI uses rawMessages.
   */
  readonly projectName: string | null;
  /** Most recent raw message text. */
  readonly rawMessageText: string;
  /**
   * Rolling window of up to 5 recent unresolved messages, oldest first.
   * Prevents an earlier "Office Orange County" from being lost when a later
   * "hey" arrives.
   */
  readonly rawMessages: readonly string[];
  readonly setAtMs: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class UserContextStore {
  private readonly senderStore = new Map<string, SenderContext>();
  private readonly chatStore = new Map<number, ChatContext>();

  // ---- Sender context ----

  /**
   * Store (or replace) the sender's context from their latest text message.
   *
   * @param sentAtMs  Actual send-time of the message in ms since epoch.
   *                  Pass `Date.now()` for real-time messages; pass the
   *                  converted Apple message date when seeding from history
   *                  so the 20-minute validity window is accurate.
   */
  setSender(
    senderId: string,
    rawMessageText: string,
    opts?: {
      readonly projectName?: string;
      readonly locationHint?: string;
      readonly descriptionHint?: string;
      readonly sentAtMs?: number;
    },
  ): void {
    this.senderStore.set(senderId, {
      rawMessageText,
      ...(opts?.projectName !== undefined
        ? { projectName: opts.projectName }
        : {}),
      ...(opts?.locationHint !== undefined
        ? { locationHint: opts.locationHint }
        : {}),
      ...(opts?.descriptionHint !== undefined
        ? { descriptionHint: opts.descriptionHint }
        : {}),
      setAtMs: opts?.sentAtMs ?? Date.now(),
    });
  }

  /**
   * Returns the stored sender context regardless of age.
   * Use this when you need the stored text but will determine validity yourself.
   */
  getSender(senderId: string): SenderContext | null {
    return this.senderStore.get(senderId) ?? null;
  }

  /**
   * Returns the sender context only if it is still within the 20-minute
   * validity window (based on the original message send time).
   * Returns null when no context exists or when it has expired.
   */
  getValidSender(senderId: string): SenderContext | null {
    const entry = this.senderStore.get(senderId);
    if (!entry) return null;
    if (Date.now() - entry.setAtMs > SENDER_VALIDITY_WINDOW_MS) return null;
    return entry;
  }

  invalidateSender(senderId: string): void {
    this.senderStore.delete(senderId);
  }

  // ---- Chat context ----

  /**
   * Store a resolved project as strong chat context.
   * Always overwrites any existing hint or resolved context.
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
   * Accumulates up to 5 recent messages (oldest first) rather than replacing,
   * so that project-mentioning text is not lost when newer small-talk arrives.
   * Never downgrades an existing resolved project context.
   */
  setChatHint(chatId: number, rawText: string): void {
    const existing = this.chatStore.get(chatId);
    if (
      existing?.projectName != null &&
      Date.now() - existing.setAtMs <= CHAT_TTL_MS
    ) {
      return; // resolved context still valid — do not downgrade to raw hint
    }

    const existingMessages: readonly string[] =
      existing != null && Date.now() - existing.setAtMs <= CHAT_TTL_MS
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
    if (Date.now() - entry.setAtMs > CHAT_TTL_MS) {
      this.chatStore.delete(chatId);
      return null;
    }
    return entry;
  }
}
