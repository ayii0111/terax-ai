import { invoke, isTauri } from "@tauri-apps/api/core";

const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

// WKWebView hides user-installed fonts from web content, so an installed Nerd
// Font is registered from its file under this name (see `fonts.rs`). It sits
// after JetBrains Mono, so only glyphs JetBrains Mono lacks (prompt icons)
// fall through to it; until it is registered the name is simply skipped.
const SYMBOL_FAMILY = "Terax Nerd Symbols";
const FALLBACK_CHAIN = `"JetBrains Mono", "${SYMBOL_FAMILY}", SFMono-Regular, Menlo, monospace`;

let detected: string | null = null;
let monoReady: Promise<void> | null = null;

export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
    loadInstalledNerdSymbols(),
  ]).then(() => undefined);
  return monoReady;
}

/** Registers an installed Nerd Font only when the webview cannot see one. */
async function loadInstalledNerdSymbols(): Promise<void> {
  if (!isTauri() || typeof FontFace === "undefined") return;
  if (detectMonoFontFamily() !== FALLBACK_CHAIN) return;
  const bytes = await invoke<ArrayBuffer>("terminal_nerd_font", {
    families: NERD_FONT_CANDIDATES,
  });
  if (bytes.byteLength === 0) return;
  document.fonts.add(await new FontFace(SYMBOL_FAMILY, bytes).load());
}

export function resolveFontFamily(userInput: string): string {
  const name = userInput.trim();
  if (!name) return detectMonoFontFamily();
  // A comma means the user gave a full stack; otherwise quote the single family.
  // Strip any quotes first so a stray quote can't produce a malformed token.
  const head = name.includes(",") ? name : `"${name.replace(/['"]/g, "")}"`;
  return `${head}, ${FALLBACK_CHAIN}`;
}

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined") {
    detected = FALLBACK_CHAIN;
    return detected;
  }
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    const sample = "Wim0123\ue0a0\ue718";
    const fallbacks = ["monospace", "serif"];
    const widths = fallbacks.map((fallback) => {
      context.font = `16px ${fallback}`;
      return context.measureText(sample).width;
    });
    for (const font of NERD_FONT_CANDIDATES) {
      if (
        fallbacks.some((fallback, index) => {
          context.font = `16px "${font}", ${fallback}`;
          return context.measureText(sample).width !== widths[index];
        })
      ) {
        detected = `"${font}", ${FALLBACK_CHAIN}`;
        return detected;
      }
    }
  }
  detected = FALLBACK_CHAIN;
  return detected;
}
