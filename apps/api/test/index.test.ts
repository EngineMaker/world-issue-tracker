import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

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
