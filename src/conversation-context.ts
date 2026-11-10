/** Surface-neutral prompt context: who is asking, where, and how answers render. */

export interface SurfaceTraits {
  /** e.g. "Slack", as in "another Slack thread". */
  name: string;
  /** e.g. "Slack messages". */
  messageNoun: string;
  /** Slotted into the prompt's numbered answer rules. */
  formattingRules: string[];
  /** Extra Q&A instructions, e.g. features this surface doesn't support. */
  notes?: string[];
}

export interface ConversationContext {
  surface: SurfaceTraits;
  requester: {
    /** Real surface ID, not a display name: tools take it as an argument. */
    id: string;
    name: string;
    email?: string;
    title?: string;
    status?: string;
  };
  place: {
    /** Capitalized, e.g. "Channel" or "Issue". */
    label: string;
    id: string;
    name: string;
    /** Shown after the ID, e.g. "dm" / "channel". */
    kind?: string;
    url?: string;
    topic?: string;
    purpose?: string;
  };
  /** Lets tools (e.g. the scheduler) tag work with its origin thread. */
  threadId?: string;
  customPrompt?: string;
  priorConversation?: string;
  linkedConversation?: string;
}
