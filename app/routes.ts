import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("shop", "routes/shop.tsx"),
  route("admin", "routes/admin.tsx"),
  route("admin/products", "routes/admin-products.tsx"),
  route("admin/products/new", "routes/admin-product-new.tsx"),
  route("admin/products/:productId/edit", "routes/admin-product-edit.tsx"),
  route(
    "media/products/:productId/:imageId/:profile",
    "routes/media-product-image.ts",
  ),
] satisfies RouteConfig;
