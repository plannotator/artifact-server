import { type CSSProperties, useEffect, useState } from "react";
import { ColorsIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Popover } from "@base-ui/react/popover";

type ReviewAccent = "blue" | "cream" | "default" | "ink" | "orange" | "paper" | "purple";

interface AccentOption {
  readonly colors: readonly [string, string];
  readonly id: ReviewAccent;
  readonly label: string;
}

interface DebugSwatchStyle extends CSSProperties {
  readonly "--as-debug-swatch-a": string;
  readonly "--as-debug-swatch-b": string;
}

const accentStorageKey = "artifact-review-debug-accent";
const accentOptions: readonly AccentOption[] = [
  {
    colors: ["oklch(0.511 0.262 276.966)", "oklch(0.457 0.24 277.023)"],
    id: "default",
    label: "Default",
  },
  { colors: ["#8465cc", "#6e51b5"], id: "purple", label: "Purple" },
  { colors: ["#3477c4", "#2560a6"], id: "blue", label: "Blue" },
  { colors: ["#ea6a20", "#d45412"], id: "orange", label: "Orange" },
  { colors: ["#f2ecdc", "#e2dac3"], id: "cream", label: "Cream" },
  { colors: ["#faf7ee", "#eae5d6"], id: "paper", label: "Paper" },
  { colors: ["#161513", "#191919"], id: "ink", label: "Ink" },
];

/** Local-only control for comparing the colors already present in the Artifact Server mark. */
export function ReviewAccentDebugger() {
  const [accent, setAccent] = useState<ReviewAccent>(readStoredAccent);

  useEffect(() => {
    if (accent === "default") {
      delete document.documentElement.dataset["reviewAccent"];
      window.localStorage.removeItem(accentStorageKey);
      return;
    }
    document.documentElement.dataset["reviewAccent"] = accent;
    window.localStorage.setItem(accentStorageKey, accent);
  }, [accent]);

  const selected = accentOptions.find((option) => option.id === accent) ?? accentOptions[0];

  return (
    <aside aria-label="Accent color preview" className="as-accent-debugger">
      <Popover.Root>
        <Popover.Trigger
          render={(
            <button
              aria-label={`Preview accent color. ${selected?.label ?? "Default"} selected.`}
              className="as-accent-debugger__trigger"
              type="button"
            />
          )}
        >
          <HugeiconsIcon aria-hidden="true" icon={ColorsIcon} strokeWidth={1.8} />
          <span>Accent</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="end"
            className="as-accent-debugger__positioner"
            side="top"
            sideOffset={8}
          >
            <Popover.Popup aria-label="Choose an accent color" className="as-accent-debugger__popover">
              <header className="as-accent-debugger__header">
                <strong>Accent preview</strong>
                <span>Local only</span>
              </header>
              <div className="as-accent-debugger__grid">
                {accentOptions.map((option) => {
                  const swatchStyle: DebugSwatchStyle = {
                    "--as-debug-swatch-a": option.colors[0],
                    "--as-debug-swatch-b": option.colors[1],
                  };
                  return (
                    <button
                      aria-label={`Use ${option.label} accent`}
                      aria-pressed={accent === option.id}
                      className="as-accent-debugger__option"
                      key={option.id}
                      onClick={() => setAccent(option.id)}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="as-accent-debugger__swatch"
                        style={swatchStyle}
                      >
                        <span />
                        <span />
                      </span>
                      <span>{option.label}</span>
                      {accent === option.id ? (
                        <HugeiconsIcon aria-hidden="true" icon={Tick02Icon} strokeWidth={2} />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </aside>
  );
}

function readStoredAccent(): ReviewAccent {
  const stored = window.localStorage.getItem(accentStorageKey);
  return accentOptions.find((option) => option.id === stored)?.id ?? "default";
}
