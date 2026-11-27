import type { HTMLAttributes } from "react";

export function Card({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`ui-card ${className}`.trim()}>
      {children}
    </div>
  );
}
