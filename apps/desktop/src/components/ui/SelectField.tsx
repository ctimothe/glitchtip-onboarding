import { ChevronsUpDown } from "lucide-react";

import { Field } from "./Field";

// The native select element drawn as a macOS pop-up button; its menu stays native.
export function SelectField({
  label,
  value,
  onChange,
  options,
  description,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  description?: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field
      label={label}
      description={description}
      error={error}
      render={({ id, describedBy, invalid }) => (
        <span className="ui-popup">
          <select
            id={id}
            value={value}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.target.value)}
            className="ui-popup__select"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="ui-popup__indicator" aria-hidden="true">
            <ChevronsUpDown size={11} strokeWidth={2.5} />
          </span>
        </span>
      )}
    />
  );
}
