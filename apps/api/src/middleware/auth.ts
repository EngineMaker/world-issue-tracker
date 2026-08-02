import { getAuth } from "@hono/clerk-auth";
import type { Context, Next } from "hono";

/**
 * Clerk の認証結果がコンテキストに載っているか。
 *
 * `clerkMiddleware` は `c.set("clerkAuth", fn)` に「関数」を入れ、`getAuth` は
 * それを `c.get("clerkAuth")(options)` と即座に呼ぶ。つまり Clerk が
 * 初期化に失敗して何も入っていない状態で `getAuth` を呼ぶと、未認証を表す
 * `undefined` ではなく TypeError になる。
 *
 * `clerkAuth()`（middleware/clerk.ts）はキー不在時に例外を握って未認証のまま
 * 先へ進めるので、その状態でここが落ちないよう `getAuth` の手前で確認する。
 */
function hasClerkAuth(c: Context): boolean {
	return typeof c.get("clerkAuth") === "function";
}

export async function requireAuth(c: Context, next: Next) {
	const auth = hasClerkAuth(c) ? getAuth(c) : undefined;
	if (!auth?.userId) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
}
