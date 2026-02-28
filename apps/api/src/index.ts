import { Hono } from "hono";
import { health } from "./routes/health";
import { issues } from "./routes/issues";

type Bindings = {
	DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
	return c.json({ name: "World Issue Tracker API", status: "ok" });
});

app.route("/health", health);
app.route("/issues", issues);

export default app;
