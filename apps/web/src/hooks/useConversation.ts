import { useCallback, useState } from "react";

const STORAGE_KEY = "keelson.conversationId";

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* sessionStorage may be blocked */
  }
}

function clearStored(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* sessionStorage may be blocked */
  }
}

export function useConversation(): {
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
} {
  const [conversationId, setConversationIdState] = useState<string | null>(() => readStored());

  const setConversationId = useCallback((id: string | null) => {
    setConversationIdState(id);
    if (id) writeStored(id);
    else clearStored();
  }, []);

  return { conversationId, setConversationId };
}
