import { CaretDown } from "@phosphor-icons/react";
import { forwardRef, useId } from "react";
import type { SelectHTMLAttributes } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: string | undefined;
  hint?: string | undefined;
  label: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { children, className = "", error, hint, id: providedId, label, ...props },
  ref,
) {
  const generatedId = useId();
  const id = providedId ?? `select-${generatedId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [props["aria-describedby"], hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={`ui-field ${className}`.trim()}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-select">
        <select
          {...props}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="ui-input ui-select__control"
          id={id}
          ref={ref}
        >
          {children}
        </select>
        <CaretDown aria-hidden="true" className="ui-select__icon" size={16} />
      </div>
      {hint ? (
        <p className="ui-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="ui-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});
