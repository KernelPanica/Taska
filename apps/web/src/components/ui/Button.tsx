import { CircleNotch } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export function Button({
  children,
  className = "",
  disabled,
  loading = false,
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={`ui-button ui-button--${variant} ${className}`.trim()}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <CircleNotch aria-hidden="true" className="ui-spinner" size={20} /> : null}
      <span>{children}</span>
    </button>
  );
}
