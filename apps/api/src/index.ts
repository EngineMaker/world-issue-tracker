import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAllowedOrigin } from "./middleware/origin";
import { health } from "./routes/health";
import { issues } from "./routes/issues";

export type Bindings = {
	DB: D1Database;
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
};

/**
 * ブラウザからの書き込みを許可するオリジン。
 * CORS と Origin 検証の両方で同じリストを使う（片方だけ更新される事故を防ぐため）。
 *
 * Origin 検証を入れたことで、ここに無いオリジンは書き込みが 403 になる。
 * CORS だけの頃は「レスポンスを読めない」で済んでいたが、今は完全に遮断されるため、
 * Web のデプロイ先を変えたときはここも必ず更新すること。
 */
export const ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"https://world-issue-tracker-web.mktoho.workers.dev",
	"https://world-issue-tracker.pages.dev",
];

export function createApp() {
	const app = new Hono<{ Bindings: Bindings }>();

	app.use(
		cors({
			origin: ALLOWED_ORIGINS,
			allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
		}),
	);

	// CORS より後、認証より前に置く。
	// CORS はブラウザにレスポンスを読ませない仕組みでしかなく、simple request の
	// 送信自体は止められない。書き込み系はサーバー側でも Origin を検証する。
	app.use(requireAllowedOrigin(ALLOWED_ORIGINS));

	// Clerk はここで全ルートに適用しない。認証を要求するルート側で個別に差す
	// （src/middleware/clerk.ts）。公開エンドポイントを Clerk の設定・可用性から
	// 切り離すため。

	app.get("/", (c) => {
		return c.json({ name: "World Issue Tracker API", status: "ok" });
	});

	app.route("/health", health);
	app.route("/issues", issues);

	return app;
}

export default createApp();
