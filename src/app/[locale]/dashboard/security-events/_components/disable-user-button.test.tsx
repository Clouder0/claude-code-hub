import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DisableUserButton } from "./disable-user-button";

const mocks = vi.hoisted(() => ({
  toggleUserEnabled: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { user?: string }) =>
    values?.user ? `${key}:${values.user}` : key,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/api-client/v1/actions/users", () => ({
  toggleUserEnabled: mocks.toggleUserEnabled,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/alert-dialog", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  );
  return {
    AlertDialog: Wrapper,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Wrapper,
    AlertDialogDescription: Wrapper,
    AlertDialogFooter: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogTitle: Wrapper,
    AlertDialogTrigger: Wrapper,
  };
});

async function renderAndConfirm() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DisableUserButton userId={7} userName="operator" disabled={false} />));
  const confirm = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "actions.confirm"
  );
  await act(async () => {
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root.unmount());
  container.remove();
}

describe("DisableUserButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("refreshes only after a confirmed successful disable", async () => {
    mocks.toggleUserEnabled.mockResolvedValue({ ok: true });
    await renderAndConfirm();
    expect(mocks.toggleUserEnabled).toHaveBeenCalledWith(7, false);
    expect(mocks.success).toHaveBeenCalledWith("actions.success:operator");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("shows the action error without claiming success or refreshing", async () => {
    mocks.toggleUserEnabled.mockResolvedValue({ ok: false, error: "permission denied" });
    await renderAndConfirm();
    expect(mocks.error).toHaveBeenCalledWith("permission denied");
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
