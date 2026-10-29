import { CONTROL_CLASS, Field } from "./Field";

export function TextArea({
  label,
  value,
  onChange,
  description,
  error,
  placeholder,
  rows = 4,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <Field
      label={label}
      description={description}
      error={error}
      wide
      render={({ id, describedBy, invalid }) => (
        <textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`${CONTROL_CLASS} ui-input--multiline`}
        />
      )}
    />
  );
}
