import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

vi.mock("@hono/clerk-auth", () => ({
	clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
	getAuth: () => ({ userId: null }),
}));

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

describe("Health check", () => {
	it("returns healthy with D1 connection", async () => {
		const res = await app.request("/health", {}, env);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("healthy");
	});
});
