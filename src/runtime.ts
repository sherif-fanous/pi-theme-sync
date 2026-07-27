/**
 * Long-running theme-detection runtime.
 *
 * Owns detection orchestration (subscription vs polling preference), the
 * active poller and drift-poller intervals, the cached current-appearance
 * state, and the read-only `RuntimeStatus` surface read by the Status
 * overlay. Does NOT own configuration persistence (lives in `config.ts`) or
 * any interactive UI (lives in `command.ts`).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import {
  detectAppearance,
  probeAvailablePollingDetectors,
  probeAvailableSubscriptionDetectors,
} from "./detectors/index.js";
import {
  type DecMode2031Subscription,
  enableDecMode2031Subscription,
} from "./detectors/terminal/dec-mode-2031.js";
import {
  type Osc11Subscription,
  enableOsc11Subscription,
} from "./detectors/terminal/osc-11.js";
import type {
  Appearance,
  PollingDetector,
  RuntimeConfig,
  RuntimeStatus,
  SubscriptionDetector,
} from "./types.js";

const DETECTOR_LABELS: Record<PollingDetector | SubscriptionDetector, string> =
  {
    "dec-mode-2031": "DEC mode 2031",
    "dsr-996": "DSR 996/997",
    "osc-11": "OSC 11",
    system: "System Appearance",
  };

export type ThemeSyncRuntime = {
  cleanup: () => void;
  getStatus: (ctx: ExtensionContext) => RuntimeStatus;
  setupAppearanceMonitoring: (ctx: ExtensionContext) => Promise<void>;
};

export function createThemeSyncRuntime(): ThemeSyncRuntime {
  let runtimeConfig: RuntimeConfig = structuredClone(DEFAULT_CONFIG);

  let currentAppearance: Appearance = "unknown";
  let availableDetectors: string[] = [];
  let detectionStrategy = "startup";
  let lastResolvedPollingDetector: PollingDetector | undefined;

  let lastUpdateAt: number | undefined;
  let lastEvent = "Not yet updated";
  let warnings: string[] = [];

  let runtimeConfigSources = {
    isSyncActive: "default",
    themes: { light: "default", dark: "default" },
    detection: { pollIntervalMs: "default" },
  } as RuntimeStatus["configSources"];

  let poller: ReturnType<typeof setInterval> | undefined;
  let driftPoller: ReturnType<typeof setInterval> | undefined;
  let decMode2031Subscription: DecMode2031Subscription | undefined;
  let osc11Subscription: Osc11Subscription | undefined;
  let isShutDown = false;

  const applyMappedTheme = (
    ctx: ExtensionContext,
    detectedAppearance: "light" | "dark",
  ) => {
    if (!runtimeConfig.isSyncActive) {
      return;
    }

    const desiredThemeName = runtimeConfig.themes[detectedAppearance];

    try {
      if (desiredThemeName === ctx.ui.theme.name) {
        return;
      }

      ctx.ui.setTheme(desiredThemeName);
    } catch {
      // Stale ctx after session replacement — nothing to apply.
    }
  };

  const markEvent = (message: string) => {
    lastEvent = message;
    lastUpdateAt = Date.now();
  };

  const resolvePollingAppearance = async (
    ctx: ExtensionContext,
    availablePollingDetectors: PollingDetector[],
  ): Promise<Appearance> => {
    for (const detector of availablePollingDetectors) {
      if (isShutDown) {
        return "unknown";
      }

      const detectedAppearance = await detectAppearance(ctx, detector);

      if (detectedAppearance !== "unknown") {
        lastResolvedPollingDetector = detector;

        return detectedAppearance;
      }
    }

    lastResolvedPollingDetector = undefined;

    return "unknown";
  };

  const cleanup = () => {
    if (poller) {
      clearInterval(poller);
      poller = undefined;
    }

    if (driftPoller) {
      clearInterval(driftPoller);
      driftPoller = undefined;
    }

    decMode2031Subscription?.removePiTerminalInputListener();
    decMode2031Subscription?.disableTerminalNotifications();
    decMode2031Subscription = undefined;

    osc11Subscription?.removeListener();
    osc11Subscription = undefined;

    isShutDown = true;
  };

  const setupAppearanceMonitoring = async (ctx: ExtensionContext) => {
    cleanup();
    isShutDown = false;

    const loadedConfig = await loadConfig(ctx);

    runtimeConfig = loadedConfig.runtimeConfig;
    runtimeConfigSources = loadedConfig.runtimeConfigSources;
    warnings = [...loadedConfig.warnings];

    const availablePollingDetectors = await probeAvailablePollingDetectors(ctx);
    const availableSubscriptionDetectors =
      await probeAvailableSubscriptionDetectors(ctx);

    availableDetectors = [
      ...availableSubscriptionDetectors.map(
        (detector) => DETECTOR_LABELS[detector],
      ),
      ...availablePollingDetectors.map((detector) => DETECTOR_LABELS[detector]),
    ];

    const initialAppearance = await resolvePollingAppearance(
      ctx,
      availablePollingDetectors,
    );

    if (initialAppearance !== "unknown") {
      currentAppearance = initialAppearance;

      markEvent(`Detected ${initialAppearance} appearance`);
      applyMappedTheme(ctx, initialAppearance);
    } else {
      currentAppearance = "unknown";

      markEvent("Appearance detection failed");
    }

    if (!runtimeConfig.isSyncActive) {
      detectionStrategy = "Inactive";

      return;
    }

    if (
      availablePollingDetectors.length === 0 &&
      availableSubscriptionDetectors.length === 0
    ) {
      warnings.push("No appearance detectors available on this terminal");
    }

    if (currentAppearance === "unknown" && runtimeConfig.isSyncActive) {
      warnings.push(
        "Sync is active but appearance is unknown — no theme applied",
      );
    }

    // Always register an OSC 11 listener for unsolicited color updates.
    // Many terminals send \x1b]11;rgb:... on theme change, and tmux forwards
    // these SET sequences to the inner terminal (unlike DSR queries which it
    // handles internally). This catches theme changes that polling and
    // DEC mode 2031 subscriptions miss inside terminal multiplexers.
    registerOsc11Listener(ctx);

    // Exclude osc-11 from the polling loop: the subscription listener above
    // already handles OSC 11 in real time. If polling also sent osc-11
    // queries, the subscription listener (registered first in inputListeners)
    // would consume the responses first, causing every polling query to time
    // out. Polling now only covers the remaining detectors (dsr-996, system)
    // as a fallback for environments where the terminal doesn't push
    // unsolicited OSC 11 updates.
    const pollingDetectorsForLoop = availablePollingDetectors.filter(
      (detector) => detector !== "osc-11",
    );

    if (osc11Subscription && pollingDetectorsForLoop.length === 0) {
      detectionStrategy = "OSC 11 (subscription)";
    }

    for (const detector of availableSubscriptionDetectors) {
      if (detector === "dec-mode-2031") {
        const subscription = enableDecMode2031Subscription(
          ctx,
          (detectedAppearance: Appearance) => {
            if (isShutDown) {
              return;
            }

            if (detectedAppearance !== "unknown") {
              currentAppearance = detectedAppearance;
              detectionStrategy = DETECTOR_LABELS[detector];

              markEvent(`Detected ${detectedAppearance} appearance`);
              applyMappedTheme(ctx, detectedAppearance);
            }
          },
        );

        if (subscription) {
          decMode2031Subscription = subscription;
          detectionStrategy = DETECTOR_LABELS[detector];

          driftPoller = setInterval(() => {
            if (isShutDown) {
              return;
            }

            if (currentAppearance !== "unknown") {
              const desiredThemeName = runtimeConfig.themes[currentAppearance];

              if (desiredThemeName !== ctx.ui.theme.name) {
                markEvent(
                  `Drift corrected: reapplied ${currentAppearance} theme`,
                );
                applyMappedTheme(ctx, currentAppearance);
              }
            }
          }, runtimeConfig.detection.pollIntervalMs);

          return;
        }
      }
    }

    if (pollingDetectorsForLoop.length > 0) {
      detectionStrategy = lastResolvedPollingDetector
        ? DETECTOR_LABELS[lastResolvedPollingDetector]
        : "Polling";

      poller = setInterval(() => {
        void resolvePollingAppearance(ctx, pollingDetectorsForLoop).then(
          (detectedAppearance: Appearance) => {
            if (isShutDown) {
              return;
            }

            if (detectedAppearance !== "unknown") {
              currentAppearance = detectedAppearance;
              detectionStrategy = lastResolvedPollingDetector
                ? DETECTOR_LABELS[lastResolvedPollingDetector]
                : "Polling";

              markEvent(`Detected ${detectedAppearance} appearance`);
              applyMappedTheme(ctx, detectedAppearance);
            }
          },
        );
      }, runtimeConfig.detection.pollIntervalMs);

      return;
    }

    // Preserve detectionStrategy set above (e.g. "OSC 11 (subscription)")
    // when the subscription listener is active. Only fall back to
    // "No available detectors" when nothing is working.
    if (!osc11Subscription && pollingDetectorsForLoop.length === 0) {
      detectionStrategy = "No available detectors";
    }
  };

  const registerOsc11Listener = (ctx: ExtensionContext) => {
    const sub = enableOsc11Subscription(ctx, (detectedAppearance) => {
      if (isShutDown) {
        return;
      }

      if (detectedAppearance !== "unknown") {
        currentAppearance = detectedAppearance;

        markEvent(`Detected ${detectedAppearance} via OSC 11 update`);
        applyMappedTheme(ctx, detectedAppearance);
      }
    });

    if (sub) {
      osc11Subscription = sub;
    }
  };

  const getStatus = (ctx: ExtensionContext): RuntimeStatus => {
    const desiredTheme: string | undefined =
      currentAppearance === "unknown"
        ? undefined
        : currentAppearance === "light"
          ? runtimeConfig.themes.light
          : runtimeConfig.themes.dark;

    return {
      currentAppearance,
      desiredTheme,
      appliedTheme: ctx.ui.theme.name ?? "unknown",

      detectionStrategy,
      availableDetectors,
      syncStatus: runtimeConfig.isSyncActive ? "active" : "inactive",
      pollIntervalMs: runtimeConfig.detection.pollIntervalMs,

      configSources: runtimeConfigSources,
      warnings,
      lastUpdateAt,
      lastEvent,
    };
  };

  return {
    cleanup,
    getStatus,
    setupAppearanceMonitoring,
  };
}
