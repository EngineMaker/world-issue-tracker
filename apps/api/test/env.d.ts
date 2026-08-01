/// <reference types="@cloudflare/vitest-pool-workers" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Bindings } from "../src/index";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {
		/**
		 * `migrations/*.sql` の中身。`vitest.config.ts` が Node.js 側で読んで
		 * バインディングとして渡す。テストは `applyD1Migrations` に流し込む。
		 */
		TEST_MIGRATIONS: D1Migration[];
	}
}
