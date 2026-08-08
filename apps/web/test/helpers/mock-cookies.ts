import { mock } from "bun:test";

/**
 * `next/headers` の `cookies()` をテスト用に差し替える（Issue #82）。
 *
 * 表示言語は Cookie から読む（`src/lib/locale.ts`）ので、Server Component を
 * `renderToStaticMarkup` で直接呼ぶこのリポジトリのテスト手法では、
 * Next.js のリクエストスコープが無く `cookies()` が例外を投げる。
 *
 * **本番のコードを「スコープ外なら既定ロケール」に緩めるのではなく、
 * テスト側でスコープを用意する形にしている。** 前者にすると、
 * リクエストスコープの外で描画されてしまった（＝言語の切り替えが効かない）
 * ときに例外ではなく黙って日本語で描かれ、壊れていることに気付けない。
 *
 * `mock.module` はモジュール解決より前に評価される必要があるため、
 * テスト対象の import より先にこのモジュールを import すること
 * （`bun` は静的 import を巻き上げるが、import の順序は保たれる）。
 */

/** 現在のテストが「どの Cookie を持つリクエストか」。各テストから差し替える。 */
let cookieValues: Record<string, string> = {};

/** テストの中で Cookie の内容を差し替える。指定しなければ空（＝既定ロケール）。 */
export function setTestCookies(values: Record<string, string>): void {
	cookieValues = values;
}

/** 前のテストの Cookie を持ち越さないためのリセット。 */
export function clearTestCookies(): void {
	cookieValues = {};
}

mock.module("next/headers", () => ({
	// 実物は `Promise<ReadonlyRequestCookies>` を返す。`src/lib/locale.ts` が
	// 使うのは `get()` だけなので、そこだけを持つ最小の代役にする
	cookies: async () => ({
		get: (name: string) =>
			name in cookieValues ? { name, value: cookieValues[name] } : undefined,
	}),

	// `headers` と `draftMode` も必ず出すこと。
	//
	// `mock.module` はモジュール全体を差し替えるので、ここに書かなかった
	// export は「存在しない」ことになる。`@clerk/nextjs` は
	// `import { headers } from "next/headers"` をしており、モックに
	// `headers` が無いと `Export named 'headers' not found in module` で
	// 落ちる。実際に CI がこれで失敗した（手元では Clerk を読み込む
	// テストが先に走らず再現しなかった）。
	//
	// このリポジトリのテストは `headers()` の中身を使わないので、
	// 空の `Headers` を返す最小の代役で足りる。
	headers: async () => new Headers(),
	draftMode: async () => ({ isEnabled: false }),
}));
