import { clerkMiddleware } from "@hono/clerk-auth";
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

	app.use(clerkMiddleware());

	app.get("/", (c) => {
		return c.json({ name: "World Issue Tracker API", status: "ok" });
	});

	app.route("/health", health);
	app.route("/issues", issues);

	// 未定義ルートの 404 も JSON に揃える。
	//
	// Hono の既定ハンドラは text/plain の "404 Not Found" を返すが、
	// `/issues/:id` の 404 は `{"error": "Issue not found"}` の JSON なので、
	// 同じ 404 でも経路によって形式が変わってしまう。
	app.notFound((c) => {
		return c.json({ error: "Not Found" }, 404);
	});

	// 想定外の例外をアプリ全体で JSON の 500 に正規化する。
	//
	// これが無いと Hono の既定ハンドラが text/plain の "Internal Server Error" を
	// 返し、他のエラーがすべて `{"error": ...}` の JSON なのと不整合になる。
	// クライアントがエラー形式を一つに決め打ちできるようにする。
	//
	// 本文には固定文言だけを載せる（例外のメッセージやスタックは内部情報なので
	// 返さない）。原因の追跡は console.error 経由のログで行う。
	app.onError((err, c) => {
		console.error(err);
		return c.json({ error: "Internal Server Error" }, 500);
	});

	return app;
}

export default createApp();
