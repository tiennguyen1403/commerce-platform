import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountMenu } from "./account-menu";
import { TENANT_THEME_PORTAL_ATTR } from "@/lib/theme";

/**
 * `AccountMenu` unit tests (first `*.test.tsx` in the `dom` project).
 *
 * The menu popup is a real Base UI `Menu` (portals to `<body>`, positions via
 * `ResizeObserver`, animates open/close) — none of which jsdom implements, so
 * driving it through a real trigger-click would be brittle (see the module doc
 * on `@/components/ui/dropdown-menu`). That machinery belongs to Base UI, which
 * is already exercised elsewhere (#113); it is not this component's logic.
 * Instead, the dropdown primitives are stubbed with plain, always-rendered
 * elements so every test here exercises `AccountMenu`'s own, previously-untested
 * logic deterministically: the name/email fallback text, the "My orders" link
 * target, the tenant-theme portal marker (#113 pattern — easy to forget on a new
 * storefront body-portal), and the sign-out orchestration (call order + the
 * error-recovery path), mirroring the admin `SignOutButton`'s same contract.
 */

const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));
const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock("@/server/auth/client", () => ({
  authClient: { signOut: signOutMock },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Stand-ins for the Base UI-backed primitives (see file doc): render everything
// unconditionally ("always open") and forward only real DOM props, so the real
// `handleSignOut`/label logic runs against real DOM without React warning about
// Base UI-only props (`align`, `sideOffset`, `closeOnClick`, ...) landing on a
// plain element.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    ...props
  }: React.ComponentProps<"button">) => <button {...props}>{children}</button>,
  DropdownMenuContent: ({
    children,
    className,
    ...rest
  }: React.ComponentProps<"div"> & Record<string, unknown>) => {
    // Keep only the `data-tenant-theme-portal` marker (and any other data-*
    // attribute) from the rest — drop Base UI positioning-only props
    // (align/sideOffset/...) that aren't valid DOM attributes.
    const dataProps = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key.startsWith("data-")),
    );
    return (
      <div className={className} {...dataProps}>
        {children}
      </div>
    );
  },
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuLinkItem: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement<{ children?: React.ReactNode }>;
    closeOnClick?: boolean;
  }) => React.cloneElement(render, {}, children),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountMenu", () => {
  it("shows the shopper's name and falls back to email when no name is set", () => {
    render(<AccountMenu name="Ada Lovelace" email="ada@example.com" />);
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();

    cleanup();

    render(<AccountMenu name={null} email="ada@example.com" />);
    // No name: the trigger and the menu label both fall back to the email, and
    // the label's secondary "Your account" line still renders.
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Your account")).toBeInTheDocument();
  });

  it("links My orders to the order history page", () => {
    render(<AccountMenu name="Ada Lovelace" email="ada@example.com" />);
    expect(screen.getByRole("link", { name: /my orders/i })).toHaveAttribute(
      "href",
      "/account/orders",
    );
  });

  it("stamps the tenant-theme portal marker on the popup content", () => {
    const { container } = render(
      <AccountMenu name="Ada Lovelace" email="ada@example.com" />,
    );
    expect(
      container.querySelector(`[${TENANT_THEME_PORTAL_ATTR}]`),
    ).not.toBeNull();
  });

  it("signs out, then routes to the catalog and refreshes, in order", async () => {
    signOutMock.mockResolvedValueOnce(undefined);
    render(<AccountMenu name="Ada Lovelace" email="ada@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalled());

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/products");
    expect(refreshMock).toHaveBeenCalledTimes(1);

    const order = [
      ...signOutMock.mock.invocationCallOrder,
      ...pushMock.mock.invocationCallOrder,
      ...refreshMock.mock.invocationCallOrder,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the shopper signed in and re-enables retry when sign-out fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    signOutMock.mockRejectedValueOnce(new Error("network down"));
    render(<AccountMenu name="Ada Lovelace" email="ada@example.com" />);

    const button = screen.getByRole("button", { name: /sign out/i });
    fireEvent.click(button);

    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));

    // Never navigates away on failure, and the button becomes clickable again
    // (not stuck disabled) so the shopper can retry.
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(button).not.toBeDisabled());
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
