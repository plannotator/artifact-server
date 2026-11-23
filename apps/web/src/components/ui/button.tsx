import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type {ComponentProps} from "react";

import { cn } from "@/lib/utils";

/** Shared visual variants for buttons and button-like controls. */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-(--dur-short) ease-(--ease-out) outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary),var(--foreground)_14%)]",
        outline:
          "border-[var(--color-rule-2)] bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "border-[var(--color-bad)] bg-[var(--color-bad-soft)] text-[var(--color-bad)] hover:bg-[color-mix(in_oklab,var(--color-bad-soft),var(--color-bad)_14%)]",
        link: "text-primary underline underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-4 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "h-7 gap-1 px-3 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        lg: "h-10 gap-1.5 px-5 has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        icon: "size-9",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Renders the preset's accessible Base UI button. */
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/** Render navigation with link semantics and the shared button appearance. */
function ButtonLink({
  className,
  variant = "default",
  size = "default",
  ...props
}: ComponentProps<"a"> & VariantProps<typeof buttonVariants>) {
  return (
    <a
      data-slot="button-link"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, ButtonLink, buttonVariants };
