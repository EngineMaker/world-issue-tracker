import { getAuth } from "@hono/clerk-auth";
import type { Context, Next } from "hono";

export async function requireAuth(c: Context, next: Next) {
	const auth = getAuth(c);
	if (!auth?.userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
}
