import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Multi-line text control matching the preset's underlined input treatment. */
function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-20 w-full min-w-0 resize-y border border-transparent border-b-input bg-transparent px-0 py-2 text-base leading-6 transition-[color,border-color] outline-none placeholder:text-muted-foreground focus-visible:border-b-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-b-destructive md:text-sm dark:aria-invalid:border-b-destructive/50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
