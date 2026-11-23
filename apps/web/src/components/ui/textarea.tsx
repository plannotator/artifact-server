import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Multi-line text control matching the preset's underlined input treatment. */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full min-w-0 resize-y rounded-[var(--radius-pill)] border border-input bg-[var(--color-paper-3)] px-3 py-2 text-base leading-6 transition-[color,border-color] outline-2 outline-transparent -outline-offset-3 placeholder:text-muted-foreground focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive md:text-sm ",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
