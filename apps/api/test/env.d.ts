/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Bindings } from "../src/index";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {}
}
