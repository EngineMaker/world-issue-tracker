import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
};

export const health = new Hono<{ Bindings: Bindings }>();

/**
 * ヘルスチェック。認証もレート制限も無い公開エンドポイント。
 *
 * D1 のエラーはテーブル名・カラム名やバンドル後のパスを含み得るため、
 * レスポンスには載せずステータスだけを返す。原因の切り分けは Workers の
 * ログ（`wrangler tail` / Observability）で行う。
 */
health.get("/", async (c) => {
	try {
		await c.env.DB.prepare("SELECT 1 as ok").first();
		return c.json({ status: "healthy" });
	} catch (e) {
		console.error("health check failed", e);
		return c.json({ status: "unhealthy" }, 500);
	}
});
