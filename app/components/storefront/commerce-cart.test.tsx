// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterProvider,
  useActionData,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTestQuote,
  type CartLine,
  type DeliveryMethod,
  type QuoteVariant,
  type TestQuote,
} from "../../lib/commerce/quote";
import { CommerceCart } from "./commerce-cart";

const key = "velaform-local-test-cart-v1";
const variants: QuoteVariant[] = [
  {
    id: "gold",
    sku: "TEST-GOLD",
    name: "Test necklace",
    colour: "Gold",
    sizeDescription: "Fictional 40 cm chain",
    priceCents: 1995,
    available: 4,
    active: true,
    version: 1,
  },
  {
    id: "silver",
    sku: "TEST-SILVER",
    name: "Test necklace",
    colour: "Silver",
    sizeDescription: "Fictional 40 cm chain",
    priceCents: 2100,
    available: 2,
    active: true,
    version: 1,
  },
  {
    id: "black",
    sku: "TEST-BLACK",
    name: "Test necklace",
    colour: "Black",
    sizeDescription: "Fictional one size",
    priceCents: 1000,
    available: 0,
    active: true,
    version: 1,
  },
];
let root: Root;
let dispose: (() => void) | undefined;
let submitted: FormData | undefined;

async function mount(
  options: {
    quote?: TestQuote;
    quoteId?: string;
    error?: string;
    items?: QuoteVariant[];
  } = {},
) {
  function Page() {
    const actionQuote = useActionData() as TestQuote | undefined;
    return (
      <CommerceCart
        variants={options.items ?? variants}
        quote={actionQuote ?? options.quote}
        quoteId={options.quoteId}
        error={options.error}
      />
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: "/test-cart",
        Component: Page,
        action: async ({ request }) => {
          submitted = await request.formData();
          if (submitted.get("intent") === "reserve") return null;
          return buildTestQuote(
            JSON.parse(String(submitted.get("lines"))) as CartLine[],
            variants,
            submitted.get("delivery") as DeliveryMethod,
            Date.now(),
          );
        },
      },
    ],
    { initialEntries: ["/test-cart"] },
  );
  dispose = () => router.dispose();
  await act(async () => root.render(<RouterProvider router={router} />));
}

function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) =>
      item.textContent === text || item.getAttribute("aria-label") === text,
  );
  expect(found, text).toBeTruthy();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function lines(): CartLine[] {
  return JSON.parse(
    (document.querySelector('input[name="lines"]') as HTMLInputElement).value,
  );
}
async function quantity(value: string, index = 0) {
  const input = document.querySelectorAll<HTMLInputElement>(
    'input[type="number"]',
  )[index];
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="test-root"></div>';
  root = createRoot(document.getElementById("test-root")!);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submitted = undefined;
});
afterEach(async () => {
  await act(async () => root.unmount());
  dispose?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local test commerce cart", () => {
  it("does not present a missing saved item as zero in a complete subtotal", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "missing", quantity: 1 }]),
    );
    await mount();
    expect(document.querySelector(".commerce-estimate")?.textContent).toContain(
      "Unavailable — review missing items",
    );
    expect(button("Get test quote").disabled).toBe(true);
  });

  it("labels test assumptions, exposes sizes as text and disables an empty cart or sold-out colour", async () => {
    await mount();
    expect(
      document
        .querySelector(".commerce-cart-panel")!
        .compareDocumentPosition(document.querySelector(".commerce-catalog")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.body.textContent).toContain("Your bag is empty");
    expect(document.body.textContent).toContain(
      "Local test only — fictional fees and tax. No payment is taken.",
    );
    expect(document.body.textContent).toContain("Fictional 40 cm chain");
    expect(document.querySelectorAll("select")).toHaveLength(1);
    expect(button("Get test quote").disabled).toBe(true);
    expect(button("Add to cart: Test necklace — Black").disabled).toBe(true);
    expect(document.querySelector('input[name="address"]')).toBeNull();
  });

  it("adds separate colours, edits/removes quantities and persists only ids and quantities", async () => {
    await mount();
    await click("Add to cart: Test necklace — Gold");
    await click("Add to cart: Test necklace — Gold");
    await click("Add to cart: Test necklace — Silver");
    expect(lines()).toEqual([
      { variantId: "gold", quantity: 2 },
      { variantId: "silver", quantity: 1 },
    ]);
    await quantity("3");
    expect(lines()[0].quantity).toBe(3);
    await click("Remove Test necklace — Silver");
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual([
      { variantId: "gold", quantity: 3 },
    ]);
    expect(document.querySelector('input[type="number"]')?.id).toBe(
      document.querySelector('label[for*="quantity"]')?.getAttribute("for"),
    );
    await click("Remove Test necklace — Gold");
    expect(button("Get test quote").disabled).toBe(true);
  });

  it("posts only intent, lines and delivery and displays amounts from the server quote", async () => {
    await mount();
    await click("Add to cart: Test necklace — Gold");
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "shipping";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Get test quote");
    expect([...submitted!.keys()].sort()).toEqual([
      "delivery",
      "intent",
      "lines",
    ]);
    expect(submitted!.get("intent")).toBe("quote");
    expect(submitted!.get("delivery")).toBe("shipping");
    expect(
      document.querySelector('[aria-label="Server test quote"]')?.textContent,
    ).toContain("34.95");
    await click("Add to cart: Test necklace — Silver");
    expect(
      document.querySelector('[aria-label="Server test quote"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain(
      "previous quote is no longer current",
    );
  });

  it("hides a quote after changing delivery even if changed back", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "gold", quantity: 1 }]),
    );
    const quote = buildTestQuote(
      [{ variantId: "gold", quantity: 1 }],
      variants,
      "pickup",
      Date.now(),
    );
    await mount({ quote });
    expect(
      document.querySelector('[aria-label="Server test quote"]'),
    ).not.toBeNull();
    for (const value of ["local_delivery", "pickup"]) {
      await act(async () => {
        const select = document.querySelector("select")!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        document.querySelector('[aria-label="Server test quote"]'),
      ).toBeNull();
    }
  });

  it("expires quotes without requiring another customer interaction", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "gold", quantity: 1 }]),
    );
    const quote = buildTestQuote(
      [{ variantId: "gold", quantity: 1 }],
      variants,
      "pickup",
      Date.now(),
    );
    await mount({ quote });
    expect(
      document.querySelector('[aria-label="Server test quote"]'),
    ).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(600_001));
    expect(
      document.querySelector('[aria-label="Server test quote"]'),
    ).toBeNull();
  });

  it("restores ids and quantities while discarding stored client money", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([
        { variantId: "gold", quantity: 2, priceCents: 1, totalCents: 1 },
      ]),
    );
    await mount();
    expect(lines()).toEqual([{ variantId: "gold", quantity: 2 }]);
    await click("Get test quote");
    expect(
      document.querySelector('[aria-label="Server test quote"]')?.textContent,
    ).toContain("39.90");
  });

  it.each([
    "{",
    "x".repeat(8193),
    "null",
    JSON.stringify(
      Array.from({ length: 21 }, (_, i) => ({
        variantId: String(i),
        quantity: 1,
      })),
    ),
    '[{"variantId":"gold","quantity":1.5}]',
    '[{"variantId":"gold","quantity":21}]',
    '[{"variantId":"gold","quantity":1},{"variantId":"gold","quantity":1}]',
  ])(
    "rejects malformed or oversized saved carts without crashing (%#)",
    async (stored) => {
      window.localStorage.setItem(key, stored);
      await mount();
      expect(lines()).toEqual([]);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be loaded",
      );
      await click("Add to cart: Test necklace — Gold");
      expect(lines()).toHaveLength(1);
    },
  );

  it("keeps unavailable restored items removable and blocks insufficient stock quotes", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([
        { variantId: "missing", quantity: 1 },
        { variantId: "gold", quantity: 5 },
      ]),
    );
    await mount();
    expect(button("Get test quote").disabled).toBe(true);
    expect(
      document
        .querySelector('input[type="number"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    await click("Remove Unavailable item");
    await quantity("2");
    expect(button("Get test quote").disabled).toBe(false);
  });

  it("handles unavailable storage while still allowing a quote", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    await mount();
    await click("Add to cart: Test necklace — Gold");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot be saved",
    );
    expect(button("Get test quote").disabled).toBe(false);
  });

  it("refuses invalid quantity and additions beyond available stock", async () => {
    await mount();
    await click("Add to cart: Test necklace — Silver");
    await quantity("0");
    expect(lines()[0].quantity).toBe(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "whole quantity",
    );
    await click("Add to cart: Test necklace — Silver");
    await click("Add to cart: Test necklace — Silver");
    expect(lines()[0].quantity).toBe(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "not enough",
    );
  });

  it("enforces the maximum cart rows and per-item quantity", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...variants[0],
      id: `v${i}`,
      sku: `SKU${i}`,
      colour: `Colour ${i}`,
      available: 100,
    }));
    window.localStorage.setItem(
      key,
      JSON.stringify(
        many.slice(0, 20).map((v) => ({ variantId: v.id, quantity: 20 })),
      ),
    );
    await mount({ items: many });
    await click("Add to cart: Test necklace — Colour 20");
    expect(lines()).toHaveLength(20);
    await click("Add to cart: Test necklace — Colour 0");
    expect(lines()[0].quantity).toBe(20);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "at most 20",
    );
  });

  it("does not show an already expired quote", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "gold", quantity: 1 }]),
    );
    const quote = buildTestQuote(
      [{ variantId: "gold", quantity: 1 }],
      variants,
      "pickup",
      Date.now() - 600_001,
    );
    await mount({ quote });
    expect(
      document.querySelector('[aria-label="Server test quote"]'),
    ).toBeNull();
  });

  it("shows server product prices and posts only the quote reference when reserving", async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "gold", quantity: 1 }]),
    );
    const quote = buildTestQuote(
      [{ variantId: "gold", quantity: 1 }],
      variants,
      "pickup",
      Date.now(),
    );
    await mount({ quote, quoteId: "test-quote-123" });
    expect(
      document.querySelector('[aria-label="Test products"]')?.textContent,
    ).toContain("$19.95 CAD");
    expect(document.querySelectorAll("h1")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(2);
    expect(document.querySelector("form form")).toBeNull();
    await click("Reserve quoted items (test only)");
    expect([...submitted!.entries()]).toEqual([
      ["intent", "reserve"],
      ["quoteId", "test-quote-123"],
    ]);
  });

  it.each(["quantity", "delivery", "expiry"])(
    "removes the reservation form when %s invalidates the quote",
    async (change) => {
      vi.useFakeTimers();
      window.localStorage.setItem(
        key,
        JSON.stringify([{ variantId: "gold", quantity: 1 }]),
      );
      const quote = buildTestQuote(
        [{ variantId: "gold", quantity: 1 }],
        variants,
        "pickup",
        Date.now(),
      );
      await mount({ quote, quoteId: "test-quote-123" });
      expect(button("Reserve quoted items (test only)")).toBeTruthy();
      if (change === "quantity") await quantity("2");
      if (change === "delivery") {
        await act(async () => {
          const select = document.querySelector("select")!;
          select.value = "shipping";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      if (change === "expiry")
        await act(async () => vi.advanceTimersByTime(600_001));
      expect(document.querySelector('input[name="quoteId"]')).toBeNull();
      expect(
        document.querySelector('[aria-label="Server test quote"]'),
      ).toBeNull();
    },
  );

  it.each([
    "missing-reference",
    "changed-version",
    "changed-price",
    "server-error",
  ])("withholds reservation for %s", async (condition) => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ variantId: "gold", quantity: 1 }]),
    );
    const quote = buildTestQuote(
      [{ variantId: "gold", quantity: 1 }],
      variants,
      "pickup",
      Date.now(),
    );
    await mount({
      quote,
      quoteId: condition === "missing-reference" ? undefined : "test-quote-123",
      error: condition === "server-error" ? "Stock changed." : undefined,
      items: variants.map((v) =>
        v.id !== "gold"
          ? v
          : {
              ...v,
              version:
                condition === "changed-version" ? v.version + 1 : v.version,
              priceCents:
                condition === "changed-price" ? v.priceCents + 1 : v.priceCents,
            },
      ),
    });
    expect(document.querySelector('input[name="quoteId"]')).toBeNull();
  });

  it("exposes server errors as an alert", async () => {
    await mount({ error: "Stock changed. Request a new quote." });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Stock changed. Request a new quote.",
    );
  });
});
