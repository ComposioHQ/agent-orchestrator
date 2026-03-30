"use client";

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";

interface InlineMessageInputProps {
  sessionId: string;
  onSend: (sessionId: string, message: string) => Promise<void>;
  onCancel: () => void;
  placeholder?: string;
}

export function InlineMessageInput({
  sessionId,
  onSend,
  onCancel,
  placeholder = "Send a message to this session...",
}: InlineMessageInputProps) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setError(null);
    try {
      await onSend(sessionId, trimmed);
      setMessage("");
    } catch {
      setError("Failed to send. Try again.");
    } finally {
      setSending(false);
    }
  }, [message, sessionId, onSend, sending]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSend, onCancel],
  );

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={sending}
        className="w-full resize-none border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
        style={{
          fontFamily: "var(--font-mono)",
          minHeight: 44,
          borderRadius: "2px",
        }}
      />
      {error && (
        <p className="text-[12px] text-[var(--color-status-error)]">{error}</p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={sending}
          className="px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
          style={{ minHeight: 44, borderRadius: "2px" }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={!message.trim() || sending}
          className="border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ minHeight: 44, borderRadius: "2px" }}
        >
          {sending ? "Sending\u2026" : "Send"}
        </button>
      </div>
    </div>
  );
}
