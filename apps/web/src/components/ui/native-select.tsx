import * as React from "react";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { cn } from "@/lib/utils";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
};

/** Native select with one consistently centered product chevron. */
function NativeSelect({
  className,
  size = "default",
  ...props
}: NativeSelectProps) {
  return (
    <div
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-10 w-full min-w-0 appearance-none rounded-none border border-input bg-background py-2 pr-9 pl-3 text-sm transition-[color,border-color,box-shadow] outline-none select-none selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-[size=sm]:h-9 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
        {...props}
      />
      <HugeiconsIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground select-none"
        data-slot="native-select-icon"
        icon={ChevronDownIcon}
        strokeWidth={2}
      />
    </div>
  );
}

/** Option styled for the operating system's native select surface. */
function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

/** Native option group styled for the operating system's select surface. */
function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
