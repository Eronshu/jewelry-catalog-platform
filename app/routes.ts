import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("shop", "routes/shop.tsx"),
  route("cart", "routes/cart.tsx"),
  route("checkout/quote", "routes/checkout-quote.ts"),
  route("commerce-lab", "routes/commerce-lab.tsx"),
  route("shop/page", "routes/shop-page.ts"),
  route("products/:slug", "routes/product-detail.tsx"),
  route("admin", "routes/admin.tsx"),
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
