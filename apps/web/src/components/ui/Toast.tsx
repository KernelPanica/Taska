import { CheckCircle, Info, Warning, X, XCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface ToastProps {
  children?: ReactNode;
  dismissLabel?: string;
  onDismiss?: () => void;
  title: string;
  variant?: "info" | "success" | "warning" | "danger";
}

const icons = {
  info: Info,
  success: CheckCircle,
  warning: Warning,
  danger: XCircle,
};

export function Toast({
  children,
  dismissLabel = "Dismiss notification",
  onDismiss,
  title,
  variant = "info",
}: ToastProps) {
  const Icon = icons[variant];
  const urgent = variant === "danger" || variant === "warning";

  return (
    <div
      aria-live={urgent ? "assertive" : "polite"}
      className={`ui-toast ui-toast--${variant}`}
      role={urgent ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="ui-toast__icon" size={20} weight="fill" />
      <div className="ui-toast__content">
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
      {onDismiss ? (
        <button aria-label={dismissLabel} className="ui-icon-button" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={20} />
        </button>
      ) : null}
    </div>
  );
}
