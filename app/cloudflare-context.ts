import { createContext } from "react-router";

export interface CloudflareRequestContext {
  readonly env: Env;
  readonly ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareRequestContext>();
