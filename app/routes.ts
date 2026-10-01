import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("shop", "routes/shop.tsx"),
  route(
    "media/products/:productId/:imageId/:profile",
    "routes/media-product-image.ts",
  ),
] satisfies RouteConfig;
