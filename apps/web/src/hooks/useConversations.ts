import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "@keelson/shared";
import {
  deleteConversation as apiDeleteConversation,
  listConversations,
  renameConversation as apiRenameConversation,
} from "../api.ts";

export interface UseConversationsResult {
  conversations: Conversation[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  // Optimistic local insertion — Chat.tsx calls this after a fresh
  // POST /api/conversations so the sidebar updates without a round-trip.
  upsertLocal: (conv: Conversation) => void;
  // Same idea for in-place mutations (auto-name applied server-side after
  // the first turn). Keeps the sidebar reactive to chat-handler writes.
  patchLocal: (id: string, patch: Partial<Conversation>) => void;
}

export function useConversations(): UseConversationsResult {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listConversations();
      setConversations(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rename = useCallback(async (id: string, name: string) => {
    const updated = await apiRenameConversation(id, name);
    setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await apiDeleteConversation(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const upsertLocal = useCallback((conv: Conversation) => {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === conv.id);
      if (idx === -1) return [...prev, conv];
      const next = prev.slice();
      next[idx] = conv;
      return next;
    });
  }, []);

  const patchLocal = useCallback(
    (id: string, patch: Partial<Conversation>) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
    },
    [],
  );

  return { conversations, loading, error, refresh, rename, remove, upsertLocal, patchLocal };
}
