import { scrubPlaneEnv } from "./scrub-plane-env.ts";

// Runs once before any test file loads (wired from bunfig.toml [test].preload):
// every file in the process sees the same bare env CI sees.
scrubPlaneEnv();
