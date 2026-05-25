// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useState } from "react";
import { getClaudeCliStatus, getCopilotCliStatus } from "../../api.ts";

interface AuthWarningProps {
  // Active provider id. Empty / unknown / "stub" renders nothing — only
  // Copilot and Claude have real auth surfaces.
  providerId: string;
}

interface ProbeState {
  authenticated: boolean;
  hint?: string;
}

// Per-provider failure copy. The CLI/env path is intentionally listed in
// the order we want users to consider: env first (zero-friction, no
// browser round-trip) → CLI fallback. Update when a provider gains a new
// auth path.
const FAIL_COPY: Record<string, { label: string; hint: string }> = {
  copilot: {
    label: "GitHub Copilot",
    hint: "Run `copilot auth login` in a terminal, then refresh.",
  },
  claude: {
    label: "Claude",
    hint: "Set ANTHROPIC_API_KEY in `.env` or run `claude auth login`, then refresh.",
  },
};

export function AuthWarning({ providerId }: AuthWarningProps) {
  const [state, setState] = useState<ProbeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    if (providerId === "copilot") {
      void getCopilotCliStatus()
        .then((s) => {
          if (cancelled) return;
          setState({
            authenticated: s.authenticated,
            ...(s.statusMessage ? { hint: s.statusMessage } : {}),
          });
        })
        .catch(() => {
          // Probe failures are themselves a signal — surface as
          // unauthenticated so the user sees the configured-incorrectly
          // path instead of a silent fail-on-send.
          if (!cancelled) setState({ authenticated: false });
        });
    } else if (providerId === "claude") {
      void getClaudeCliStatus()
        .then((s) => {
          if (cancelled) return;
          setState({
            authenticated: s.authenticated,
            ...(s.statusMessage ? { hint: s.statusMessage } : {}),
          });
        })
        .catch(() => {
          if (!cancelled) setState({ authenticated: false });
        });
    } else {
      // Stub / unknown providers have no auth — render nothing.
      setState({ authenticated: true });
    }
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  if (!state || state.authenticated) return null;
  const copy = FAIL_COPY[providerId];
  if (!copy) return null;
  return (
    <span className="auth-warning" role="status">
      <span className="auth-warning-icon" aria-hidden="true">
        ⚠
      </span>
      <span className="auth-warning-text">
        Not signed in to {copy.label}. {copy.hint}
      </span>
    </span>
  );
}
