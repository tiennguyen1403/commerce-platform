import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "@/lib/utils";

/**
 * A placeholder block for streamed/loading content — a `bg-muted animate-pulse`
 * box. Server-safe (no `"use client"`, like `Badge`/`Card`); takes a `render`
 * prop (never `asChild`) so a caller can swap the element or reshape it.
 */
function Skeleton({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn("bg-muted animate-pulse rounded-md", className),
      },
      props,
    ),
    render,
    state: {
      slot: "skeleton",
    },
  });
}

export { Skeleton };
