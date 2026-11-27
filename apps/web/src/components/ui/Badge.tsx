import type { HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: "neutral" | "info" | "success" | "warning" | "danger";
}

export function Badge({ children, className = "", variant = "neutral", ...props }: BadgeProps) {
  return (
    <span {...props} className={`ui-badge ui-badge--${variant} ${className}`.trim()}>
      {children}
    </span>
  );
}
