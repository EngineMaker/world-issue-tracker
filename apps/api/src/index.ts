import {
	LEGACY_WEB_ORIGINS,
	PRODUCTION_WEB_ORIGIN,
} from "@world-issue-tracker/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { clerkKeyKindWarning } from "./middleware/clerk";
import { requireAllowedOrigin } from "./middleware/origin";
import { health } from "./routes/health";
import { issues } from "./routes/issues";

export type Bindings = {
	DB: D1Database;
	/** Issue に添付する写真の置き場（#65）。設定は wrangler.jsonc の `r2_buckets` */
	PHOTOS: R2Bucket;
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
	/**
	 * 表明者の表示名を Clerk から引いた結果を載せる KV（#135）。
	 * 設定は wrangler.jsonc の `kv_namespaces`。
	 *
	 * オプショナルにしているのは、バインディングが未設定の環境でも公開エンドポイント
	 * を落とさないため。未設定なら `fetchDisplayNames` は毎回 Clerk へ問い合わせる
	 * （従来どおり動くが、無認証の連打による増幅は止まらない）。
	 */
	DISPLAY_NAME_CACHE?: KVNamespace;
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
	// 本番の入口。Clerk の本番インスタンスもこのドメインに紐づく（#98）
	PRODUCTION_WEB_ORIGIN,
	// 切り替え前の入口。消してよくなる条件は shared 側のコメントを参照
	...LEGACY_WEB_ORIGINS,
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
	//
	// 例外は「開発用インスタンスのキーで動いていないか」の警告（#98）だけ。
	// これは env の文字列を見るだけで Clerk に問い合わせないため、公開経路の
	// 可用性に影響しない。認証を要求するルートにだけ差すと、閲覧者しか来ない
	// 期間は警告が一度も出ず、一番知りたい状況が一番ログに出なくなる。
	app.use(clerkKeyKindWarning());

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
