import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// モックの層については helpers/clerk-mock.ts を参照。
// このファイルは認証を要求しないルートだけを見るため、未認証のまま使う。
vi.mock("@clerk/backend", async () => {
	const { clerkBackendMockFactory } = await import("./helpers/clerk-mock");
	return clerkBackendMockFactory();
});

import { createApp } from "../src/index";

const app = createApp();

describe("API root", () => {
	it("returns status ok", async () => {
		const res = await app.request("/", {}, env);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			name: "World Issue Tracker API",
			status: "ok",
		});
	});
});
