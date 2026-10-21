// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Checkout from "../../routes/checkout";
import { ShoppingCartProvider, useShoppingCart } from "./shopping-cart-context";
import { SHOPPING_CART_KEY } from "../../lib/commerce/shopping-cart";
import type { CheckoutInput, CheckoutQuote } from "../../lib/commerce/checkout";
import {
  loadGooglePlaces,
  type GooglePlace,
  type PlacesLibrary,
} from "../../lib/commerce/google-places.client";

vi.mock("../../lib/commerce/google-places.client", () => ({
  loadGooglePlaces: vi.fn(),
}));
const testBrowserKey = "AIza" + "x".repeat(35);
let googleWidget: HTMLElement;
let widgetOptions: unknown;
const placeComponents = () => [
  { types: ["country"], shortText: "CA", longText: "Canada" },
  { types: ["street_number"], longText: "200" },
  { types: ["route"], longText: "Fictional New Street" },
  { types: ["locality"], longText: "New Test City" },
  { types: ["administrative_area_level_1"], shortText: "BC" },
  { types: ["postal_code"], longText: "V1A 0B1" },
];
async function selectPlace(place: GooglePlace) {
  await act(async () => {
    const event = new Event("gmp-select");
    Object.defineProperty(event, "placePrediction", {
      value: { toPlace: () => place },
    });
    googleWidget.dispatchEvent(event);
  });
}

let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
let fetchMock: ReturnType<typeof vi.fn>;
let requests: CheckoutInput[];
const lines = [{ variantId: "gold", quantity: 2 }];
function response(
  input: CheckoutInput,
  overrides: Partial<CheckoutQuote> = {},
) {
  const quote: CheckoutQuote = {
    contractVersion: "local-checkout-v1",
    requestId: input.requestId,
    testOnly: true,
    currency: "CAD",
    rulesVersion: "fictional-delivery-v1",
    expiresAt: Date.now() + 600_000,
    delivery: input.delivery.method,
    lines: input.lines.map((line) => ({
      ...line,
      sku: "TEST",
      name: "Fictional necklace",
      colour: "Gold-tone",
      sizeDescription: "Fictional size",
      unitPriceCents: 2500,
      lineTotalCents: 2500 * line.quantity,
      version: 1,
    })),
    subtotalCents: 5000,
    shippingCents: 0,
    taxBaseCents: 5000,
    taxBasisPoints: 1000,
    taxCents: 500,
    totalCents: 5500,
    ...overrides,
  };
  return Response.json({ quote });
}
function CartTools() {
  const cart = useShoppingCart();
  return (
    <>
      <button onClick={() => cart.change([{ variantId: "gold", quantity: 1 }])}>
        Change cart
      </button>
      <button onClick={() => cart.change(lines)}>Restore cart</button>
      <Outlet />
    </>
  );
}
async function mount(placesKey: string | null = null) {
  router = createMemoryRouter(
    [
      {
        Component: () => (
          <ShoppingCartProvider>
            <CartTools />
          </ShoppingCartProvider>
        ),
        children: [
          {
            path: "/checkout",
            Component: Checkout,
            loader: () => ({ localPreview: true, placesKey }),
            HydrateFallback: () => null,
          },
          { path: "/cart", element: <p>Cart</p> },
        ],
      },
    ],
    { initialEntries: ["/checkout"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
}
async function field(path: string, value: string) {
  const input = document.getElementById(
    `checkout-${path.replaceAll(".", "-")}`,
  ) as HTMLInputElement;
  expect(input, path).toBeTruthy();
  await act(async () => {
    const prototype =
      input.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(
      new Event(input.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function contact() {
  await field("contact.name", "Fictional Customer");
  await field("contact.email", "fictional@example.invalid");
}
async function address() {
  await field("delivery.address.line1", "100 Fictional Test Street");
  await field("delivery.address.line2", "Unit TEST");
  await field("delivery.address.city", "Test City");
  await field("delivery.address.province", "ON");
  await field("delivery.address.postalCode", "K1A 0B1");
}
function button(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(button, text).toBeTruthy();
  return button!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function submit() {
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
function checkbox() {
  return document.querySelector(
    'input[type="checkbox"]',
  ) as HTMLInputElement | null;
}
async function confirm() {
  await act(async () => checkbox()!.click());
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(loadGooglePlaces)
    .mockReset()
    .mockResolvedValue({
      PlaceAutocompleteElement: function (options: unknown) {
        widgetOptions = options;
        googleWidget = document.createElement("div");
        googleWidget.setAttribute("data-test-widget", "true");
        return googleWidget;
      } as unknown as PlacesLibrary["PlaceAutocompleteElement"],
    });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = [];
  fetchMock = vi.fn(async (_url, options: RequestInit) => {
    const input = JSON.parse(
      String(
        new URLSearchParams(options.body as URLSearchParams).get("checkout"),
      ),
    );
    requests.push(input);
    return response(input);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(SHOPPING_CART_KEY, JSON.stringify(lines));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  router?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local delivery form and quote review", () => {
  it("does not load Google for missing configuration, pickup or a shipping form before opt-in", async () => {
    await mount();
    await field("method", "shipping");
    expect(document.body.textContent).toContain(
      "Address suggestions are unavailable",
    );
    expect(loadGooglePlaces).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    router.dispose();
    root = createRoot(document.getElementById("root")!);
    await mount(testBrowserKey);
    expect(document.body.textContent).not.toContain(
      "Search address with Google",
    );
    await field("method", "shipping");
    expect(button("Search address with Google")).toBeTruthy();
    expect(loadGooglePlaces).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("maps a chosen Canadian address, preserves apartment edits and clears quote confirmation", async () => {
    await mount(testBrowserKey);
    await contact();
    await field("method", "shipping");
    await address();
    await submit();
    await confirm();
    await click("Search address with Google");
    expect(widgetOptions).toMatchObject({
      includedRegionCodes: ["ca"],
      requestedLanguage: "en",
      requestedRegion: "ca",
    });
    expect(JSON.stringify(widgetOptions)).not.toContain("Fictional Customer");
    const fetchFields = vi.fn().mockResolvedValue(undefined);
    await selectPlace({ addressComponents: placeComponents(), fetchFields });
    expect(fetchFields).toHaveBeenCalledWith({ fields: ["addressComponents"] });
    expect(
      (
        document.getElementById(
          "checkout-delivery-address-line1",
        ) as HTMLInputElement
      ).value,
    ).toBe("200 Fictional New Street");
    expect(
      (
        document.getElementById(
          "checkout-delivery-address-line2",
        ) as HTMLInputElement
      ).value,
    ).toBe("Unit TEST");
    expect(checkbox()).toBeNull();
    await submit();
    expect(requests.at(-1)?.delivery).toMatchObject({
      address: {
        line1: "200 Fictional New Street",
        province: "BC",
        line2: "Unit TEST",
      },
    });
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem(SHOPPING_CART_KEY)).not.toContain(
      "Street",
    );
    expect(window.sessionStorage.length).toBe(0);
  });
  it("leaves missing number/postal code empty so a previous complete address cannot slip into a new quote", async () => {
    await mount(testBrowserKey);
    await contact();
    await field("method", "shipping");
    await address();
    await click("Search address with Google");
    await selectPlace({
      addressComponents: placeComponents().filter(
        (c) =>
          !c.types.includes("street_number") &&
          !c.types.includes("postal_code"),
      ),
      fetchFields: vi.fn().mockResolvedValue(undefined),
    });
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Street address",
    );
  });
  it("ignores a late details response after manual edits, and keeps its fields editable", async () => {
    await mount(testBrowserKey);
    await field("method", "shipping");
    await address();
    await click("Search address with Google");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    // Start an event without awaiting its remote details promise.
    await selectPlace({
      addressComponents: placeComponents(),
      fetchFields: () => pending,
    });
    await field("delivery.address.line1", "300 Manual Fictional Street");
    await act(async () => finish());
    expect(
      (
        document.getElementById(
          "checkout-delivery-address-line1",
        ) as HTMLInputElement
      ).value,
    ).toBe("300 Manual Fictional Street");
    expect(document.body.textContent).toContain("Your details changed");
  });
  it.each(["pickup", "cart"])(
    "discards a late selection after changing %s",
    async (change) => {
      await mount(testBrowserKey);
      await field("method", "shipping");
      await address();
      await click("Search address with Google");
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => (finish = resolve));
      await selectPlace({
        addressComponents: placeComponents(),
        fetchFields: () => pending,
      });
      if (change === "pickup") await field("method", "pickup");
      else await click("Change cart");
      await act(async () => finish());
      if (change === "pickup") await field("method", "shipping");
      expect(
        (
          document.getElementById(
            "checkout-delivery-address-line1",
          ) as HTMLInputElement
        ).value,
      ).toBe("100 Fictional Test Street");
    },
  );
  it("drops earlier selections and in-flight details when a new search starts", async () => {
    await mount(testBrowserKey);
    await field("method", "shipping");
    await address();
    await click("Search address with Google");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    await selectPlace({
      addressComponents: placeComponents(),
      fetchFields: () => pending,
    });
    await act(async () => googleWidget.dispatchEvent(new Event("input")));
    await act(async () => finish());
    expect(
      (
        document.getElementById(
          "checkout-delivery-address-line1",
        ) as HTMLInputElement
      ).value,
    ).toBe("100 Fictional Test Street");
  });
  it.each(["load", "auth", "details", "timeout"])(
    "keeps manual entry and quotes usable after Google %s failure",
    async (failure) => {
      if (failure === "load")
        vi.mocked(loadGooglePlaces).mockRejectedValueOnce(
          new Error("private provider error"),
        );
      if (failure === "timeout") vi.useFakeTimers();
      await mount(testBrowserKey);
      await contact();
      await field("method", "shipping");
      await address();
      await click("Search address with Google");
      if (failure === "auth")
        await act(async () =>
          googleWidget.dispatchEvent(new Event("gmp-error")),
        );
      if (failure === "details")
        await selectPlace({
          fetchFields: vi.fn().mockRejectedValue(new Error("private address")),
        });
      if (failure === "timeout") {
        await selectPlace({ fetchFields: () => new Promise(() => {}) });
        await act(async () => vi.advanceTimersByTime(10_001));
      }
      expect(document.body.textContent).toContain(
        "Google address search is unavailable",
      );
      expect(document.body.textContent).not.toContain("private provider error");
      await submit();
      expect(checkbox()).not.toBeNull();
    },
  );
  it("requires fresh review after a refreshed quote changes the amount", async () => {
    await mount();
    await contact();
    await submit();
    await confirm();
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
      const input: CheckoutInput = JSON.parse(
        String(
          new URLSearchParams(options.body as URLSearchParams).get("checkout"),
        ),
      );
      return response(input, {
        subtotalCents: 6000,
        taxBaseCents: 6000,
        taxCents: 600,
        totalCents: 6600,
      });
    });
    await submit();
    expect(
      document.querySelector('[aria-label="Test quote review"]')?.textContent,
    ).toContain("66.00");
    expect(checkbox()?.checked).toBe(false);
    expect(document.body.textContent).not.toContain("Test quote reviewed.");
  });
  it("requires contact only for pickup, has native autofill, and reviews without payment", async () => {
    await mount();
    expect(document.body.textContent).toContain(
      "No order, reservation or payment",
    );
    expect(
      document.getElementById("checkout-delivery-address-line1"),
    ).toBeNull();
    expect(
      document
        .getElementById("checkout-contact-email")
        ?.getAttribute("autocomplete"),
    ).toBe("email");
    await contact();
    await submit();
    expect(requests[0].delivery).toEqual({ method: "pickup" });
    expect(fetchMock.mock.calls[0][0]).toBe("/checkout/quote");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      cache: "no-store",
    });
    expect(
      document.querySelector('[aria-label="Test quote review"]')?.textContent,
    ).toContain("55.00");
    await confirm();
    expect(document.body.textContent).toContain(
      "Test quote reviewed. No order or payment has been created.",
    );
    expect(
      document.querySelector('input[autocomplete="cc-number"]'),
    ).toBeNull();
    expect(window.localStorage.getItem(SHOPPING_CART_KEY)).toBe(
      JSON.stringify(lines),
    );
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(router.state.location.search).toBe("");
  });
  it("focuses field errors, supports error links and does not submit invalid input", async () => {
    await mount();
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      document.querySelector('[role="alert"]'),
    );
    const link = document.querySelector(
      '[role="alert"] a',
    ) as HTMLAnchorElement;
    await act(async () => link.click());
    expect(document.activeElement?.id).toBe("checkout-contact-name");
    expect(
      document
        .getElementById("checkout-contact-name")
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
  });
  it.each(["shipping", "local_delivery"])(
    "validates %s fields and preserves optional unit details",
    async (method) => {
      await mount();
      await contact();
      await field("method", method);
      await submit();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Street address",
      );
      await address();
      await submit();
      expect(requests[0].delivery).toMatchObject({
        method,
        address: { line2: "Unit TEST", country: "CA", postalCode: "K1A0B1" },
      });
      expect(
        document
          .getElementById("checkout-delivery-address-line1")
          ?.getAttribute("autocomplete"),
      ).toBe("shipping address-line1");
      await field("method", "pickup");
      await submit();
      expect(requests[1].delivery).toEqual({ method: "pickup" });
    },
  );
  it.each([
    "contact.name",
    "contact.email",
    "delivery.address.line1",
    "delivery.address.line2",
    "delivery.address.city",
    "delivery.address.postalCode",
  ])(
    "invalidates quote and confirmation even after %s is restored",
    async (path) => {
      await mount();
      await contact();
      await field("method", "shipping");
      await address();
      await submit();
      await confirm();
      const old = (
        document.getElementById(
          `checkout-${path.replaceAll(".", "-")}`,
        ) as HTMLInputElement
      ).value;
      await field(path, "changed");
      await field(path, old);
      expect(checkbox()).toBeNull();
      expect(document.body.textContent).not.toContain("Test quote reviewed.");
      await submit();
      expect(checkbox()?.checked).toBe(false);
    },
  );
  it("does not resurrect a quote after cart or delivery/province changes are reverted", async () => {
    await mount();
    await contact();
    await submit();
    await confirm();
    await click("Change cart");
    await click("Restore cart");
    expect(checkbox()).toBeNull();
    await submit();
    await confirm();
    await field("method", "shipping");
    await field("method", "pickup");
    expect(checkbox()).toBeNull();
    await field("method", "shipping");
    await address();
    await submit();
    await confirm();
    await field("delivery.address.province", "BC");
    await field("delivery.address.province", "ON");
    expect(checkbox()).toBeNull();
  });
  it("blocks duplicate submissions and ignores late responses after editing and retry", async () => {
    const late = deferred();
    let original!: CheckoutInput;
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
      original = JSON.parse(
        String(
          new URLSearchParams(options.body as URLSearchParams).get("checkout"),
        ),
      );
      return late.promise;
    });
    await mount();
    await contact();
    await submit();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await field("contact.name", "Other Fictional Customer");
    await submit();
    expect(checkbox()).not.toBeNull();
    await confirm();
    await act(async () =>
      late.resolve(response(original, { totalCents: 99999 })),
    );
    expect(document.body.textContent).not.toContain("999.99");
    expect(checkbox()?.checked).toBe(true);
  });
  it("aborts and discards pending results after cart changes", async () => {
    const late = deferred();
    let original!: CheckoutInput;
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
      original = JSON.parse(
        String(
          new URLSearchParams(options.body as URLSearchParams).get("checkout"),
        ),
      );
      signal = options.signal;
      return late.promise;
    });
    await mount();
    await contact();
    await submit();
    await click("Change cart");
    await click("Restore cart");
    expect(signal?.aborted).toBe(true);
    await act(async () => late.resolve(response(original)));
    expect(checkbox()).toBeNull();
  });
  it("times out a hanging request, permits retry and ignores its eventual result", async () => {
    vi.useFakeTimers();
    const late = deferred();
    let original!: CheckoutInput;
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
      original = JSON.parse(
        String(
          new URLSearchParams(options.body as URLSearchParams).get("checkout"),
        ),
      );
      return late.promise;
    });
    await mount();
    await contact();
    await submit();
    await act(async () => vi.advanceTimersByTime(15_001));
    expect(document.body.textContent).toContain("request timed out");
    expect(button("Get test quote").disabled).toBe(false);
    await submit();
    expect(checkbox()).not.toBeNull();
    await act(async () =>
      late.resolve(response(original, { totalCents: 99999 })),
    );
    expect(document.body.textContent).not.toContain("999.99");
  });
  it("expires reviewed amounts on timer and on returning focus from a suspended page", async () => {
    vi.useFakeTimers();
    await mount();
    await contact();
    await submit();
    await confirm();
    await act(async () => vi.advanceTimersByTime(600_001));
    expect(checkbox()).toBeNull();
    expect(document.body.textContent).toContain("quote expired");
    await submit();
    await confirm();
    vi.setSystemTime(Date.now() + 600_001);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(checkbox()).toBeNull();
    expect(document.body.textContent).not.toContain("Test quote reviewed.");
  });
  it("preserves typed fields on server errors and clears the old confirmation before retry", async () => {
    await mount();
    await contact();
    await submit();
    await confirm();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: "Delivery is unavailable for this test area.",
          fields: ["contact.email"],
        },
        { status: 422 },
      ),
    );
    await submit();
    expect(checkbox()).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[role="alert"]'),
    );
    expect(
      (document.getElementById("checkout-contact-name") as HTMLInputElement)
        .value,
    ).toBe("Fictional Customer");
    expect(
      document
        .getElementById("checkout-contact-email")
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    await submit();
    expect(checkbox()?.checked).toBe(false);
  });
  it.each([
    "requestId",
    "expired",
    "invalid-json",
    "network",
    "wrong-lines",
    "non-test",
  ])("refuses %s responses", async (kind) => {
    fetchMock.mockImplementationOnce(async (_url, options: RequestInit) => {
      if (kind === "network") throw new Error("Network failure");
      if (kind === "invalid-json") return new Response("<html>Error</html>");
      const input: CheckoutInput = JSON.parse(
        String(
          new URLSearchParams(options.body as URLSearchParams).get("checkout"),
        ),
      );
      const quote = response(
        input,
        kind === "requestId"
          ? { requestId: "wrong-id" }
          : kind === "expired"
            ? { expiresAt: Date.now() - 1 }
            : kind === "wrong-lines"
              ? { lines: [] }
              : ({ testOnly: false } as unknown as Partial<CheckoutQuote>),
      );
      return quote;
    });
    await mount();
    await contact();
    await submit();
    expect(checkbox()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be loaded",
    );
  });
  it("shows an empty cart without requesting a quote", async () => {
    window.localStorage.removeItem(SHOPPING_CART_KEY);
    await mount();
    expect(document.body.textContent).toContain("Your cart is empty");
    expect(document.querySelector("form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("forgets contact data on navigation without clearing selected items", async () => {
    await mount();
    await contact();
    await submit();
    await act(async () => router.navigate("/cart"));
    await act(async () => router.navigate("/checkout"));
    expect(
      (document.getElementById("checkout-contact-name") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(window.localStorage.getItem(SHOPPING_CART_KEY)).toBe(
      JSON.stringify(lines),
    );
  });
});
