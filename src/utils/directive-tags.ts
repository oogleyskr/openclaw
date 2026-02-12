export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
};

const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

// gpt-oss model internal tokens/action syntax that should never reach the user.
// These leak through when serving gpt-oss without --reasoning-parser.
const MODEL_SPECIAL_TOKEN_RE = /<\|[^|]+\|>/g; // <|channel|>, <|message|>, <|end|>, <|start|>, etc.
const MODEL_COMMENTARY_RE = /\bcommentary\s+to=[^\s\n]+/gi; // commentary to=functions.XXX
const MODEL_START_ROLE_RE = /^assistant\b/i; // bare "assistant" left after stripping <|start|>

/**
 * Strip model-internal tokens and action syntax from text.
 * gpt-oss (and similar models) emit special tokens like <|channel|>analysis<|message|>
 * and action directives like "commentary to=functions.memory_search" that should never
 * be shown to the user. Call this before any other text processing.
 */
export function stripModelInternalTokens(text: string): string {
  if (!text) {
    return text;
  }
  let cleaned = text;
  // Strip zero-width Unicode characters (common in garbled Harmony output)
  cleaned = cleaned.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, "");
  cleaned = cleaned.replace(MODEL_SPECIAL_TOKEN_RE, " ");
  cleaned = cleaned.replace(MODEL_COMMENTARY_RE, " ");
  // After stripping <|start|>, "assistant" may be left at the beginning
  cleaned = cleaned.replace(MODEL_START_ROLE_RE, " ");
  // Strip channel labels like "analysis" or "final" that were between <|channel|> and <|message|>
  // These appear as bare words after the special token stripping
  cleaned = cleaned.replace(/\b(?:analysis|final)\b(?=\s)/gi, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Detect garbled Harmony output: when the SGLang Harmony parser fails to
  // separate channels, corrupted markers leave behind sequences of ellipses,
  // dashes, and punctuation with very few actual words. Detect this by
  // counting ellipsis patterns in the first 200 characters.
  if (cleaned.length > 30) {
    const sample = cleaned.slice(0, Math.min(cleaned.length, 200));
    const ellipsisCount = (sample.match(/\u2026|\.\.\./g) || []).length;
    if (ellipsisCount >= 8) {
      return "";
    }
  }

  return cleaned;
}

/**
 * Returns true if the text is entirely model-internal tokens/syntax
 * with no user-facing content. Used by the runner to detect responses
 * that need re-prompting.
 */
export function isOnlyModelInternalTokens(text: string | undefined | null): boolean {
  if (!text?.trim()) {
    return false;
  }
  const stripped = stripModelInternalTokens(text);
  return stripped.length === 0;
}

function normalizeDirectiveWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
  if (!text) {
    return {
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let cleaned = stripModelInternalTokens(text);
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? " " : match;
  });

  cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw: string | undefined) => {
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? " " : match;
  });

  cleaned = normalizeDirectiveWhitespace(cleaned);

  const replyToId =
    lastExplicitId ?? (sawCurrent ? currentMessageId?.trim() || undefined : undefined);

  return {
    text: cleaned,
    audioAsVoice,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}
