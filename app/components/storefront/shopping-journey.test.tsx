// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShoppingCart from "../../routes/cart";
import ProductDetail from "../../routes/product-detail";
import {
  ShoppingCartProvider,
  ShoppingNavigation,
} from "./shopping-cart-context";
import {
  parseShoppingLines,
  SHOPPING_CART_KEY,
  type ShoppingVariant,
} from "../../lib/commerce/shopping-cart";

const gold: ShoppingVariant = {
  id: "gold",
  productId: 1,
  slug: "orbit",
  name: "Orbit",
  colour: "Gold-tone",
  sizeDescription: "Fictional size",
  priceCents: 2500,
  available: 4,
  active: true,
  imageId: 1,
  imageAlt: "Fictional necklace",
};
const silver: ShoppingVariant = {
  ...gold,
  id: "silver",
  productId: 2,
  slug: "bar",
  name: "Bar",
  colour: "Silver-tone",
  priceCents: 3000,
};
let items: ShoppingVariant[];
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
let failure = false;
let requests: unknown[];
function FixtureProduct() {
  const { slug } = useParams();
  const variants = items.filter((item) => item.slug === slug);
  const product = variants[0];
  return (
    <ProductDetail
      params={{ slug: slug! }}
      matches={[] as never}
      loaderData={{
        product: {
          name: product.name,
          priceCents: product.priceCents,
          status: "available",
          description: null,
          material: null,
          colour: null,
          facebookUrl: null,
        },
        gallery: [],
        shoppingVariants: variants,
      }}
    />
  );
}
async function mount(path = "/products/orbit") {
  router = createMemoryRouter(
    [
      {
        Component: () => (
          <ShoppingCartProvider>
            <ShoppingNavigation />
            <Outlet />
          </ShoppingCartProvider>
        ),
        children: [
          { path: "/products/:slug", Component: FixtureProduct },
          {
            path: "/cart",
            Component: ShoppingCart,
            action: async ({ request }) => {
              const form = await request.formData();
              const lines = parseShoppingLines(
                JSON.parse(String(form.get("lines"))),
              );
              requests.push(lines);
              if (failure)
                return {
                  error: "Current prices could not be loaded. Please retry.",
                };
              const rows = lines.map((line) => {
                const variant =
                  items.find((item) => item.id === line.variantId) ?? null;
                return {
                  ...line,
                  variant,
                  lineTotalCents: variant
                    ? variant.priceCents * line.quantity
                    : null,
                };
              });
              return {
                key: JSON.stringify(lines),
                testOnly: true,
                items: rows,
                subtotalCents: rows.some((row) => row.lineTotalCents === null)
                  ? null
                  : rows.reduce((sum, row) => sum + row.lineTotalCents!, 0),
              };
            },
          },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
}
function button(name: string) {
  const result = [...document.querySelectorAll("button")].find(
    (button) =>
      button.textContent === name || button.getAttribute("aria-label") === name,
  );
  expect(result).toBeTruthy();
  return result!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function navigate(path: string | number) {
  await act(async () => {
    if (typeof path === "number") await router.navigate(path);
    else await router.navigate(path);
  });
}
function stored() {
  return JSON.parse(window.localStorage.getItem(SHOPPING_CART_KEY) ?? "[]");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  items = [
    gold,
    { ...gold, id: "black", colour: "Black", available: 0 },
    silver,
  ];
  failure = false;
  requests = [];
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  router?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("local product to cart journey", () => {
  it("clears purchase feedback when navigating between same-name product details", async () => {
    items = items.map((item) => ({ ...item, name: "Fictional necklace" }));
    await mount();
    await click("Add to cart");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Added to your cart",
    );
    await navigate("/products/bar");
    expect(document.body.textContent).not.toContain("Added to your cart");
    expect(stored()).toEqual([{ variantId: "gold", quantity: 1 }]);
    await click("Add to cart");
    expect(stored()).toEqual([
      { variantId: "gold", quantity: 1 },
      { variantId: "silver", quantity: 1 },
    ]);
    await navigate(-1);
    expect(document.body.textContent).not.toContain("Added to your cart");
  });

  it("merges a SKU, adds a second product, restores after refresh and removes with focus feedback", async () => {
    await mount();
    await click("Add to cart");
    await click("Add to cart");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Added to your cart",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "2 in your cart",
    );
    expect(document.querySelector('[role="status"] a')?.textContent).toContain(
      "View cart",
    );
    await navigate("/products/bar");
    await click("Add to cart");
    await navigate("/cart");
    expect(document.body.textContent).toContain("Subtotal (3 items)");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$80.00");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/media/products/1/1/thumb",
    );
    expect(stored()).toEqual([
      { variantId: "gold", quantity: 2 },
      { variantId: "silver", quantity: 1 },
    ]);
    await navigate(-1);
    expect(document.body.textContent).toContain("View cart (3)");
    await navigate("/cart");
    await act(async () => root.unmount());
    router.dispose();
    root = createRoot(document.getElementById("root")!);
    await mount("/cart");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$80.00");
    await click("Remove Orbit — Gold-tone");
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.body.textContent).toContain("Item removed");
    expect(stored()).toEqual([{ variantId: "silver", quantity: 1 }]);
    await click("Remove Bar — Silver-tone");
    expect(document.body.textContent).toContain("Your cart is empty");
  });
  it("disables out-of-stock colours and never touches the lab cart namespace", async () => {
    window.localStorage.setItem(
      "velaform-local-test-cart-v1",
      '[{"variantId":"lab","quantity":1}]',
    );
    await mount();
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "black";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Add to cart").disabled).toBe(true);
    expect(stored()).toEqual([]);
    expect(
      window.localStorage.getItem("velaform-local-test-cart-v1"),
    ).toContain("lab");
  });
  it("rechecks changed prices and missing items without displaying a partial subtotal", async () => {
    window.localStorage.setItem(
      SHOPPING_CART_KEY,
      '[{"variantId":"gold","quantity":1},{"variantId":"missing","quantity":1}]',
    );
    await mount("/cart");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("Unavailable — review missing items");
    await click("Remove Unavailable item");
    items = items.map((item) =>
      item.id === "gold" ? { ...item, priceCents: 2700, available: 0 } : item,
    );
    await click("Refresh prices and availability");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$27.00");
    expect(document.body.textContent).toContain("Not enough available stock");
  });
  it("keeps the cart usable across navigation when saving is blocked", async () => {
    await mount();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    await click("Add to cart");
    await navigate("/cart");
    expect(document.body.textContent).toContain("cannot be saved");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$25.00");
  });
  it("clears malformed saved input safely and allows recovery", async () => {
    window.localStorage.setItem(SHOPPING_CART_KEY, "broken");
    await mount();
    expect(document.body.textContent).toContain("could not be restored");
    await click("Add to cart");
    expect(stored()).toEqual([{ variantId: "gold", quantity: 1 }]);
  });
  it("uses side-by-side quantity arrows and respects stock boundaries", async () => {
    await mount();
    await click("Add to cart");
    await navigate("/cart");
    expect(button("Decrease quantity for Orbit — Gold-tone").disabled).toBe(
      true,
    );
    await click("Increase quantity for Orbit — Gold-tone");
    await click("Increase quantity for Orbit — Gold-tone");
    expect(stored()).toEqual([{ variantId: "gold", quantity: 3 }]);
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$75.00");
    await click("Increase quantity for Orbit — Gold-tone");
    expect(button("Increase quantity for Orbit — Gold-tone").disabled).toBe(
      true,
    );
    await click("Decrease quantity for Orbit — Gold-tone");
    expect(stored()).toEqual([{ variantId: "gold", quantity: 3 }]);
    expect(document.querySelector('[role="group"]')?.textContent).toBe("‹3›");
    expect(document.body.textContent).toContain("quantity updated to 3");
  });
  it("does not add more than the available stock", async () => {
    await mount();
    for (let i = 0; i < 5; i++) await click("Add to cart");
    expect(stored()).toEqual([{ variantId: "gold", quantity: 4 }]);
    expect(document.body.textContent).toContain("not enough available stock");
  });

  it("shows a retry path instead of a stale amount after a read failure", async () => {
    await mount();
    await click("Add to cart");
    await navigate("/cart");
    failure = true;
    await click("Refresh prices and availability");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("Awaiting current prices");
    failure = false;
    await click("Refresh prices and availability");
    expect(
      document.querySelector('[aria-label="Cart summary"]')?.textContent,
    ).toContain("$25.00");
    expect(
      requests.every(
        (lines) =>
          JSON.stringify(lines) === '[{"variantId":"gold","quantity":1}]',
      ),
    ).toBe(true);
  });
});
