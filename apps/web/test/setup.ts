// Preload (apps/web/bunfig.toml) — registers DOM globals before any React
// import so component/hook tests can run under `bun test`. Resetting between
// cases here keeps the module-singleton settings store from leaking state.

import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Imported after register() so @testing-library/dom's `screen` binds to the
// now-present document rather than a throwing proxy.
const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  localStorage.clear();
});
