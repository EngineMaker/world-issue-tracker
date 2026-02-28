import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
};

export const health = new Hono<{ Bindings: Bindings }>();

health.get("/", async (c) => {
	try {
		const result = await c.env.DB.prepare("SELECT 1 as ok").first();
		return c.json({ status: "healthy", db: result });
	} catch (e) {
		return c.json({ status: "unhealthy", error: String(e) }, 500);
	}
});
