import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import type { CartLine } from "../../lib/commerce/quote";
import {
  parseShoppingLines,
  SHOPPING_CART_KEY,
} from "../../lib/commerce/shopping-cart";

type CartState = {
  lines: CartLine[];
  ready: boolean;
  warning: string;
  change: (lines: CartLine[]) => void;
};
const ShoppingContext = createContext<CartState | null>(null);
export function ShoppingCartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState("");
  useEffect(() => {
    let mounted = true;
    Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const raw = window.localStorage.getItem(SHOPPING_CART_KEY);
        if (raw && raw.length > 8192) throw new Error("Invalid cart");
        setLines(raw ? parseShoppingLines(JSON.parse(raw)) : []);
      } catch {
        setWarning(
          "Your saved cart could not be restored. You can start a new cart.",
        );
      }
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);
  function change(input: CartLine[]) {
    const next = parseShoppingLines(input);
    setLines(next);
    setWarning("");
    try {
      window.localStorage.setItem(SHOPPING_CART_KEY, JSON.stringify(next));
    } catch {
      setWarning(
        "Your cart is kept for this visit but cannot be saved on this device.",
      );
    }
  }
  return (
    <ShoppingContext.Provider value={{ lines, ready, warning, change }}>
      {children}
    </ShoppingContext.Provider>
  );
}
export function useShoppingCart() {
  const cart = useContext(ShoppingContext);
  if (!cart) throw new Error("Shopping cart requires a local preview provider");
  return cart;
}
export function ShoppingNavigation() {
  const cart = useShoppingCart();
  return (
    <nav
      className="container shopping-preview-nav"
      aria-label="Local shopping preview"
    >
      <p>Local preview · Fictional products · No real purchases or payment</p>
      <Link to="/cart">
        View cart ({cart.lines.reduce((sum, line) => sum + line.quantity, 0)})
      </Link>
      {cart.warning && <p role="status">{cart.warning}</p>}
    </nav>
  );
}
