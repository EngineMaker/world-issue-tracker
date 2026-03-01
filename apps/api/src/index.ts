import { clerkMiddleware } from "@hono/clerk-auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { health } from "./routes/health";
import { issues } from "./routes/issues";

export type Bindings = {
	DB: D1Database;
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
};

export function createApp() {
	const app = new Hono<{ Bindings: Bindings }>();

	app.use(
		cors({
			origin: [
				"http://localhost:3000",
				"https://world-issue-tracker.pages.dev",
			],
			allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
		}),
	);

	app.use(clerkMiddleware());

	app.get("/", (c) => {
		return c.json({ name: "World Issue Tracker API", status: "ok" });
	});

	app.route("/health", health);
	app.route("/issues", issues);

	return app;
}

export default createApp();
