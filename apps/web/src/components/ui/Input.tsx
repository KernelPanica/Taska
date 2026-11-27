import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string | undefined;
  hint?: string | undefined;
  label: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", error, hint, id: providedId, label, ...props },
  ref,
) {
  const generatedId = useId();
  const id = providedId ?? `input-${generatedId}`;
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
      <input
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="ui-input"
        id={id}
        ref={ref}
      />
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
