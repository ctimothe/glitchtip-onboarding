import { CONTROL_CLASS, Field } from "./Field";

export function TextField({
  label,
  value,
  onChange,
  description,
  error,
  type = "text",
  placeholder,
  autoComplete,
  disabled,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
  type?: "text" | "password" | "url" | "number";
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
  /** Paths, hosts and identifiers read better in the monospaced face. */
  mono?: boolean;
}) {
  return (
    <Field
      label={label}
      description={description}
      error={error}
      render={({ id, describedBy, invalid }) => (
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete ?? "off"}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={mono ? `${CONTROL_CLASS} ui-input--mono` : CONTROL_CLASS}
        />
      )}
    />
  );
}
