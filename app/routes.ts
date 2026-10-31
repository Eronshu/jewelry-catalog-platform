import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("shop", "routes/shop.tsx"),
  route("cart", "routes/cart.tsx"),
  route("checkout", "routes/checkout.tsx"),
  route("checkout/quote", "routes/checkout-quote.ts"),
  route("checkout/commands", "routes/checkout-commands.ts"),
  route("checkout/orders/:orderId/cancel", "routes/checkout-order-cancel.ts"),
  route("checkout/orders/:orderId/stripe", "routes/checkout-order-stripe.ts"),
  route("checkout/stripe/webhook", "routes/checkout-stripe-webhook.ts"),
  route(
    "checkout/orders/:orderId/prepare-payment",
    "routes/checkout-order-payment.ts",
  ),
  route("checkout/confirm", "routes/checkout-confirm.tsx"),
  route("checkout/orders/:orderId", "routes/checkout-order.tsx"),
  route("commerce-lab", "routes/commerce-lab.tsx"),
  route("shop/page", "routes/shop-page.ts"),
  route("products/:slug", "routes/product-detail.tsx"),
  route("admin", "routes/admin.tsx"),
  route("admin/commerce", "routes/admin-commerce.tsx"),
  route("admin/commerce/orders", "routes/admin-commerce-orders.tsx"),
  route("admin/commerce/orders/:orderId", "routes/admin-commerce-order.tsx"),
  route("admin/commerce/inventory", "routes/admin-commerce-inventory.tsx"),
  route("admin/commerce/review", "routes/admin-commerce-review.ts"),
  route(
    "admin/commerce/reservations/recover",
    "routes/admin-commerce-recover.ts",
  ),
  route(
    "admin/commerce/reservations",
    "routes/admin-commerce-reservations.tsx",
  ),
  route("admin/products", "routes/admin-products.tsx"),
  route("admin/products/new", "routes/admin-product-new.tsx"),
  route("admin/products/new/create", "routes/admin-product-create.ts"),
  route("admin/products/:productId/edit", "routes/admin-product-edit.tsx"),
  route("admin/products/:productId/photos", "routes/admin-product-photos.ts"),
  route(
    "admin/products/:productId/photos/upload",
    "routes/admin-product-photo-upload.ts",
  ),
  route(
    "admin/products/:productId/photos/:photoId",
    "routes/admin-product-photo.ts",
  ),
  route(
    "admin/products/:productId/photos/:photoId/preview",
    "routes/admin-product-photo-preview.ts",
  ),
  route(
    "media/products/:productId/:imageId/:profile",
    "routes/media-product-image.ts",
  ),
] satisfies RouteConfig;
