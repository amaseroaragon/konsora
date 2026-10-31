import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";
import { cx } from "./cx.ts";

type Common = {
  label: string;
  hint?: string;
  /** Message shown when invalid; sets aria-invalid and links it via aria-describedby. */
  error?: string;
  mono?: boolean;
  /** Visually hide the label (it stays available to assistive tech). */
  hideLabel?: boolean;
};

export type FieldProps =
  | (Common & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, "id">)
  | (Common & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">);

export function Field(props: FieldProps) {
  const id = useId();
  const { label, hint, error, mono, hideLabel, className, ...rest } = props;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const controlClass = cx("k-field__control", mono && "k-field__control--mono", className);
  const a11y = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: controlClass,
  } as const;
  return (
    <div className="k-field">
      <label htmlFor={id} className={cx("k-field__label", hideLabel && "k-visually-hidden")}>
        {label}
      </label>
      {"multiline" in rest && rest.multiline ? (
        <textarea {...omitMultiline(rest)} {...a11y} />
      ) : (
        <input {...(omitMultiline(rest) as InputHTMLAttributes<HTMLInputElement>)} {...a11y} />
      )}
      {hint && (
        <span id={hintId} className="k-field__hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="k-field__error">
          {error}
        </span>
      )}
    </div>
  );
}

function omitMultiline<T extends { multiline?: boolean }>(value: T): Omit<T, "multiline"> {
  const { multiline: _ignored, ...rest } = value;
  return rest;
}
