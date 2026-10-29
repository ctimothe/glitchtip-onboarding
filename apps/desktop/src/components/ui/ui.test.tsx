import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Archive } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AppIcon,
  Button,
  CopyButton,
  InlineAlert,
  SegmentedControl,
  SelectField,
  ServiceMark,
  Sheet,
  StatusBadge,
  Steps,
  SwatchPicker,
  TextArea,
  TextField,
} from "./index";
import { PRODUCT_MARKS } from "./ServiceMark";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is inert and busy while pending", async () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("honours disabled and type", () => {
    render(
      <Button disabled type="submit">
        Go
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
  });
});

describe("fields", () => {
  it("TextField wires label, description and error and reports changes", async () => {
    const onChange = vi.fn();
    render(
      <TextField
        label="Token"
        value=""
        onChange={onChange}
        description="From settings"
        error="Required"
        type="password"
      />,
    );
    const input = screen.getByLabelText("Token");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("From settings Required");
    await userEvent.type(input, "a");
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("TextArea reports changes", async () => {
    const onChange = vi.fn();
    render(<TextArea label="Notes" value="" onChange={onChange} rows={2} />);
    await userEvent.type(screen.getByLabelText("Notes"), "x");
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("SelectField selects an option", async () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Language"
        value="en"
        onChange={onChange}
        options={[
          { value: "en", label: "English" },
          { value: "uz", label: "Uzbek" },
        ]}
        error="Pick one"
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Language"), "uz");
    expect(onChange).toHaveBeenCalledWith("uz");
    expect(screen.getByLabelText("Language")).toHaveAccessibleDescription("Pick one");
  });
});

describe("InlineAlert", () => {
  it("is role=alert only when live", () => {
    const { rerender } = render(
      <InlineAlert tone="error" title="Failed" live>
        Body
      </InlineAlert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    rerender(<InlineAlert tone="info" title="Note" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Note");
  });
});

describe("StatusBadge", () => {
  it("shows text and a distinct shape per status", () => {
    const { container, rerender } = render(<StatusBadge status="ok" label="Healthy" />);
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    const okShape = container.querySelector("svg")?.innerHTML;
    rerender(<StatusBadge status="error" label="Down" />);
    expect(container.querySelector("svg")?.innerHTML).not.toBe(okShape);
  });
});

describe("AppIcon", () => {
  it("is a bundled image hidden beside the app's name", () => {
    const { container } = render(<AppIcon />);
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image?.getAttribute("src")).not.toMatch(/^https?:/);
  });
});

describe("ServiceMark", () => {
  it("uses local assets, never remote sources", () => {
    for (const source of Object.values(PRODUCT_MARKS)) {
      expect(source).not.toMatch(/^https?:\/\//);
    }
    render(<ServiceMark product="telegram" label="Telegram" />);
    expect(screen.getByRole("img", { name: "Telegram" }).getAttribute("src")).not.toMatch(
      /^https?:\/\//,
    );
  });

  it("renders a Lucide icon with its label", () => {
    render(<ServiceMark icon={Archive} label="Archive" />);
    expect(screen.getByRole("img", { name: "Archive" })).toBeInTheDocument();
  });
});

function SheetHarness({
  onConfirm = vi.fn(),
  destructive = true,
  pending = false,
}: {
  onConfirm?: () => void;
  destructive?: boolean;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Sheet
        open={open}
        title="Remove"
        onClose={() => setOpen(false)}
        confirm={{ label: "Delete", destructive, pending, onConfirm }}
      >
        <p>Sure?</p>
        <input aria-label="Name" />
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("renders nothing when closed", () => {
    render(<Sheet open={false} title="T" onClose={() => {}}>x</Sheet>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled dialog, traps focus, closes on Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Remove" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    for (let i = 0; i < 5; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("runs the confirm action", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<SheetHarness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("confirms on Return from a field, but never a destructive action", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<SheetHarness onConfirm={onConfirm} destructive={false} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
    unmount();

    onConfirm.mockClear();
    render(<SheetHarness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("stays open while its action runs", async () => {
    const user = userEvent.setup();
    render(<SheetHarness pending />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Remove" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

describe("SegmentedControl", () => {
  function Appearance() {
    const [value, setValue] = useState("light");
    return (
      <SegmentedControl
        label="Appearance"
        value={value}
        onChange={setValue}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "Auto" },
        ]}
      />
    );
  }

  it("is one tab stop whose arrow keys move the selection", async () => {
    const user = userEvent.setup();
    render(<Appearance />);
    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    expect(group).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("tabindex", "-1");
    await user.tab();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("SwatchPicker", () => {
  it("names every colour and selects on click", async () => {
    const onChange = vi.fn();
    render(
      <SwatchPicker
        label="Topic color"
        value="blue"
        onChange={onChange}
        options={[
          { value: "blue", label: "Blue", color: "var(--color-accent)" },
          { value: "red", label: "Red", color: "var(--color-destructive)" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Topic color" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(onChange).toHaveBeenCalledWith("red");
  });
});

describe("Steps", () => {
  it("marks the current step and says each step's state", () => {
    render(
      <Steps
        label="Setup"
        steps={[
          { key: "1", label: "Connect", state: "done", statusLabel: "Done" },
          { key: "2", label: "Deploy", state: "current", statusLabel: "In progress" },
          { key: "3", label: "Verify", state: "todo", statusLabel: "Not started" },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(items.map((item) => item.textContent)).toEqual(["ConnectDone", "DeployIn progress", "VerifyNot started"]);
  });
});

describe("CopyButton", () => {
  it("copies the text and confirms in place", async () => {
    const user = userEvent.setup();
    render(<CopyButton text="3f9c2a1" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe("3f9c2a1");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});
