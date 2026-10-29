import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFontFamily } from "./fonts";

const FALLBACK =
  '"JetBrains Mono", "Terax Nerd Symbols", SFMono-Regular, Menlo, monospace';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@tauri-apps/api/core");
  vi.resetModules();
});

describe("terminal font availability", () => {
  it("does not accept an absent font when FontFaceSet.check returns true", async () => {
    const context = {
      font: "",
      measureText: () => ({
        width:
          context.font.endsWith("serif") && !context.font.endsWith("monospace")
            ? 110
            : 100,
      }),
    };
    vi.stubGlobal("document", {
      fonts: { check: () => true },
      createElement: () => ({ getContext: () => context }),
    });
    const { detectMonoFontFamily } = await import("./fonts");
    expect(detectMonoFontFamily()).toBe(FALLBACK);
  });

  it("finds an installed later candidate and caches its measurements", async () => {
    const context = {
      font: "",
      measureText: vi.fn(() => ({
        width: context.font.includes('"Hack Nerd Font"')
          ? 130
          : context.font.endsWith(", serif") || context.font === "16px serif"
            ? 110
            : 100,
      })),
    };
    vi.stubGlobal("document", {
      createElement: () => ({ getContext: () => context }),
    });
    const { detectMonoFontFamily } = await import("./fonts");
    expect(detectMonoFontFamily()).toBe(`"Hack Nerd Font", ${FALLBACK}`);
    const calls = context.measureText.mock.calls.length;
    detectMonoFontFamily();
    expect(context.measureText).toHaveBeenCalledTimes(calls);
  });

  it("loads text fonts before canvas rasterization, only once per window", async () => {
    const load = vi.fn(async () => []);
    vi.stubGlobal("document", { fonts: { load } });
    const { ensureMonoFontsLoaded } = await import("./fonts");
    const first = ensureMonoFontsLoaded();
    expect(ensureMonoFontsLoaded()).toBe(first);
    await first;
    expect(load).toHaveBeenCalledWith('400 14px "JetBrains Mono"');
    expect(load).toHaveBeenCalledWith('700 14px "JetBrains Mono"');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no Nerd Font is visible", 100, true],
    ["a Nerd Font is already visible", 130, false],
  ])(
    "registers an installed Nerd Font only when %s",
    async (_, nerdWidth, registered) => {
      const bytes = new Uint8Array([0, 1, 0, 0]).buffer;
      const invoke = vi.fn(async () => bytes);
      vi.doMock("@tauri-apps/api/core", () => ({
        invoke,
        isTauri: () => true,
      }));
      const added: unknown[] = [];
      class FakeFontFace {
        constructor(
          readonly family: string,
          readonly source: ArrayBuffer,
        ) {}
        load = async () => this;
      }
      const context = {
        font: "",
        measureText: () => ({
          width: context.font.includes("Nerd Font") ? nerdWidth : 100,
        }),
      };
      vi.stubGlobal("FontFace", FakeFontFace);
      vi.stubGlobal("document", {
        fonts: {
          load: async () => [],
          add: (face: unknown) => added.push(face),
        },
        createElement: () => ({ getContext: () => context }),
      });
      const { ensureMonoFontsLoaded } = await import("./fonts");
      await ensureMonoFontsLoaded();

      if (registered) {
        expect(invoke).toHaveBeenCalledWith("terminal_nerd_font", {
          families: expect.arrayContaining(["Hack Nerd Font"]),
        });
        expect(added).toEqual([
          expect.objectContaining({
            family: "Terax Nerd Symbols",
            source: bytes,
          }),
        ]);
      } else {
        expect(invoke).not.toHaveBeenCalled();
        expect(added).toEqual([]);
      }
    },
  );
});

describe("resolveFontFamily", () => {
  it("quotes a bare family and appends the mono fallback", () => {
    expect(resolveFontFamily("JetBrainsMono Nerd Font")).toBe(
      `"JetBrainsMono Nerd Font", ${FALLBACK}`,
    );
  });

  it("does not double-quote an already-quoted family", () => {
    expect(resolveFontFamily('"Fira Code"')).toBe(`"Fira Code", ${FALLBACK}`);
  });

  it("passes a comma-separated stack through and still appends fallback", () => {
    expect(resolveFontFamily("Foo, Bar")).toBe(`Foo, Bar, ${FALLBACK}`);
  });

  it("strips stray internal quotes to avoid a malformed token", () => {
    expect(resolveFontFamily('Foo"Bar')).toBe(`"FooBar", ${FALLBACK}`);
  });

  it("trims surrounding whitespace before quoting", () => {
    expect(resolveFontFamily("  Hack Nerd Font  ")).toBe(
      `"Hack Nerd Font", ${FALLBACK}`,
    );
  });

  it("falls back to the mono chain for empty input", () => {
    expect(resolveFontFamily("")).toBe(FALLBACK);
    expect(resolveFontFamily("   ")).toBe(FALLBACK);
  });
});
