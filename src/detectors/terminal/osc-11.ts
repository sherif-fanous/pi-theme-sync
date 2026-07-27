/**
 * OSC 11 background-color appearance probe and subscription.
 *
 * Owns the OSC 11 query sequence and `detectAppearanceViaOsc11Background`,
 * which queries the terminal for its background color and converts the
 * hex reply to an `Appearance` via the shared `classifyHexColor`
 * luminance heuristic. Also owns `enableOsc11Subscription`, a persistent
 * listener for unsolicited OSC 11 color updates that many terminal emulators
 * send when the theme changes — this works inside tmux because tmux forwards
 * OSC color SET sequences to the inner terminal.
 *
 * Does NOT own the terminal-query primitive (delegates to `./query.ts`) or
 * the hex-to-appearance classifier (lives in `../../color.ts`).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyHexColor } from "../../color.js";
import type { Appearance } from "../../types.js";
import { queryWithTerminalListener } from "./query.js";

const OSC_11_BACKGROUND_QUERY = "\x1b]11;?\x1b\\";

export async function detectAppearanceViaOsc11Background(
  ctx: ExtensionContext,
): Promise<Appearance> {
  return (
    (await queryWithTerminalListener(ctx, OSC_11_BACKGROUND_QUERY, (data) => {
      const match = data.match(/\x1b\]11;rgb:([0-9a-fA-F/]+)(?:\x07|\x1b\\)/);

      if (!match) {
        return undefined;
      }

      const rawColor = match[1];

      if (!rawColor) {
        return undefined;
      }

      const colorParts = rawColor
        .split("/")
        .map((part) => part.slice(0, 2).padStart(2, "0"));

      if (colorParts.length < 3) {
        return undefined;
      }

      const detectedAppearance = classifyHexColor(
        `${colorParts[0]}${colorParts[1]}${colorParts[2]}`,
      );

      return detectedAppearance === "unknown" ? undefined : detectedAppearance;
    })) ?? "unknown"
  );
}

/** Opaque handle for cleaning up an OSC 11 subscription. */
export type Osc11Subscription = {
  removeListener: () => void;
};

/**
 * Parse an OSC 11 color value to a 6-char hex string.
 * Handles `rgb:RRRR/GGGG/BBBB` format (most terminals and tmux).
 */
function parseOsc11Color(raw: string): string | undefined {
  // rgb:RRRR/GGGG/BBBB
  if (raw.startsWith("rgb:")) {
    const parts = raw.slice(4).split("/");
    if (parts.length < 3) return undefined;
    const r = parts[0]?.slice(0, 2).padStart(2, "0");
    const g = parts[1]?.slice(0, 2).padStart(2, "0");
    const b = parts[2]?.slice(0, 2).padStart(2, "0");
    if (!r || !g || !b) return undefined;
    return `${r}${g}${b}`;
  }
  // #RRGGBB
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    if (hex.length !== 6) return undefined;
    return hex;
  }
  return undefined;
}

/**
 * Subscribe to unsolicited OSC 11 color updates from the terminal.
 *
 * Many terminal emulators send `\x1b]11;rgb:XXXX/XXXX/XXXX\x07` when the
 * theme / background color changes. tmux forwards these SET sequences to
 * the inner terminal (unlike DSR queries, which it handles internally).
 * This listener catches those updates in real time and classifies the
 * color as light or dark so the runtime can apply the mapped theme.
 *
 * Unlike polling or DSR-based queries, this approach works inside tmux
 * and doesn't need the terminal to support DEC mode 2031.
 */
export function enableOsc11Subscription(
  ctx: ExtensionContext,
  onColorDetected: (appearance: Appearance) => void,
): Osc11Subscription | undefined {
  if (!ctx.hasUI) {
    return undefined;
  }

  const removeListener = ctx.ui.onTerminalInput((data) => {
    // Match \x1b]11;...\x07 or \x1b]11;...\x1b\
    // Catches both unsolicited SET sequences and stray QUERY responses.
    const match = data.match(
      /\x1b\]11;(rgb:[0-9a-fA-F/]+|#[0-9a-fA-F]{6,8})(?:\x07|\x1b\\)/i,
    );

    if (!match) {
      return undefined;
    }

    const hexColor = parseOsc11Color(match[1]);

    if (!hexColor) {
      return undefined;
    }

    const appearance = classifyHexColor(hexColor);

    if (appearance !== "unknown") {
      onColorDetected(appearance);

      return { consume: true };
    }

    return undefined;
  });

  return { removeListener };
}
