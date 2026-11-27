import { CheckSquareOffset } from "@phosphor-icons/react";

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span className="app-brand__mark">
      <CheckSquareOffset aria-hidden="true" size={size} weight="fill" />
    </span>
  );
}
