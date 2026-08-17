import { clerkKeyKind } from "@world-issue-tracker/shared";
import { Hono } from "hono";

type Bindings = {
	DB: D1Database;
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
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

/**
 * 動いている Clerk インスタンスの種別を答える（#98）。
 *
 * API のキーは Workers Secrets にあり、値は書き込み専用で読み出せない
 * （`wrangler secret list` が返すのは名前と型だけ）。そのため web のように
 * ビルド前に検査して止めることができない。代わりに、デプロイした本人に
 * 種別を聞く経路をここに置く。デプロイ後にこれを叩けば、いま本番で
 * 実際に使われている値が開発用か本番用かが分かる
 * （`apps/api/scripts/verify-clerk-instance.ts` が使う）。
 *
 * ビルド時の環境変数を見るより確実である点が重要。Secrets はワークフローの
 * 外側（`wrangler secret put` を手で叩く）で変わるので、リポジトリ側の
 * どの値を見ても本番の実態とは限らない。動いている Worker に聞くしかない。
 *
 * **返すのは種別だけで、キーの値も断片も返さない。** publishable key は
 * ブラウザに配る前提の値だが、secret key はそうではない。両方を同じ
 * 「種別だけ」に揃えているのは、後から片方だけ値を足す改変を入れにくく
 * するため。判定は接頭辞（`pk_test_` / `pk_live_`）しか見ないので、
 * 種別以上の情報は元から要らない。
 *
 * 認証を掛けていない理由。この情報は Clerk のサインイン画面を開けば
 * 「Development mode」の表示で誰にでも分かるし、publishable key 自体が
 * ブラウザに配られている。秘匿する意味が無い一方、認証を掛けると
 * デプロイ直後の検証にトークンが要る。そのトークンを CI に持たせる方が、
 * 隠す価値の無い情報を隠すためのコストとして高い。
 *
 * `unset` は「設定されていない」と「Clerk のキーの形式ではない」の
 * 両方を指す。呼び出し側はこれを本番用と見なしてはいけない
 * （`clerkKeyKind` が `null` を返す条件と同じ。判定できないものを
 * 安全側に倒さないという方針は shared 側のコメントに書いてある）。
 */
health.get("/auth", (c) => {
	return c.json({
		clerk: {
			secretKey: clerkKeyKind(c.env.CLERK_SECRET_KEY) ?? "unset",
			publishableKey: clerkKeyKind(c.env.CLERK_PUBLISHABLE_KEY) ?? "unset",
		},
	});
});
