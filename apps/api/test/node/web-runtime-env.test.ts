/**
 * Web の Worker が「実行時に」読む環境変数の検査。
 *
 * `NEXT_PUBLIC_*` はビルド時にバンドルへ埋め込まれるが、埋め込まれるのは
 * Client Component だけ。Server Component の `process.env.NEXT_PUBLIC_*` は
 * 実行時に評価されるため、Workers 上に値が無ければ undefined になる。
 *
 * `@opennextjs/cloudflare` は Worker の `env`（= wrangler.jsonc の `vars` と
 * シークレット）を `process.env` へコピーしてからハンドラを呼ぶ。したがって
 * Server Component に値を届ける唯一の経路が `vars` になる。
 *
 * deploy.yml の受け渡し（setup-docs.test.ts が検査している）はビルド時の話で、
 * 実行時の有無は担保しない。ユニットテストでも型チェックでもビルドでも
 * 素通りする種類の事故なので、設定ファイルの記述そのものを検査する。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/**
 * JSONC（コメント付き JSON）をパースする。
 *
 * wrangler の設定ファイルはコメントを許すため `JSON.parse` に直接は渡せない。
 * JSONC パーサは直接の依存に無いので、文字列リテラルの内側を避けながら
 * コメントだけを落としてから `JSON.parse` する。`vars` には
 * `https://...` のような `//` を含む値が入るため、文字列の追跡は省略できない。
 */
function parseJsonc(source: string): unknown {
	let result = "";
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			// 改行はそのまま残す。JSON.parse の失敗位置を元の行と対応させるため
			if (char === "\n") {
				inLineComment = false;
				result += char;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			} else if (char === "\n") {
				result += char;
			}
			continue;
		}

		if (inString) {
			result += char;
			// エスケープされた文字は次の 1 文字ごと取り込む（`\"` で閉じない）
			if (char === "\\") {
				result += next ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		result += char;
	}

	return JSON.parse(result);
}

/** `KEY=value` 形式の行からキー名を取り出す。コメント行と空行は無視する。 */
const parseEnvKeys = (content: string) =>
	content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split("=")[0] ?? "");

function readWebWranglerVars(): Record<string, unknown> {
	const config = parseJsonc(readRepoFile("apps/web/wrangler.jsonc"));
	if (typeof config !== "object" || config === null) {
		throw new Error("apps/web/wrangler.jsonc がオブジェクトではない");
	}
	const vars = (config as { vars?: unknown }).vars;
	if (typeof vars !== "object" || vars === null) return {};
	return vars as Record<string, unknown>;
}

describe("JSONC のパース", () => {
	it("行コメントとブロックコメントを落とす", () => {
		expect(
			parseJsonc(`{
				// 行コメント
				"a": 1,
				/* ブロック
				   コメント */
				"b": 2
			}`),
		).toEqual({ a: 1, b: 2 });
	});

	it("文字列の中の // をコメントとして扱わない", () => {
		expect(parseJsonc('{ "url": "https://example.com/x" }')).toEqual({
			url: "https://example.com/x",
		});
	});

	it("エスケープされた引用符で文字列を閉じない", () => {
		expect(parseJsonc('{ "a": "he said \\"// hi\\"", "b": 1 }')).toEqual({
			a: 'he said "// hi"',
			b: 1,
		});
	});
});

describe("web の Worker が実行時に読む環境変数", () => {
	it("wrangler.jsonc の vars に NEXT_PUBLIC_API_URL がある", () => {
		// これが無いと Server Component が resolveApiBaseUrl() の既定値
		// （http://localhost:8787）へ fetch し、一覧が丸ごと取得できなくなる
		expect(
			readWebWranglerVars(),
			"apps/web/wrangler.jsonc の vars に NEXT_PUBLIC_API_URL が無い",
		).toHaveProperty("NEXT_PUBLIC_API_URL");
	});

	it("vars の NEXT_PUBLIC_API_URL が本番の API を指している", () => {
		expect(readWebWranglerVars().NEXT_PUBLIC_API_URL).toBe(
			"https://world-issue-tracker-api.mktoho.workers.dev",
		);
	});

	it("deploy.yml とビルド時・実行時で同じ URL を渡している", () => {
		// 片方だけ書き換えると、Client Component と Server Component が
		// 別の API を見に行く。壊れ方が「投稿はできるが閲覧できない」に
		// なって分かりにくいため、二つの値の一致をここで固定する
		const deployWorkflow = readRepoFile(".github/workflows/deploy.yml");
		const buildTimeUrl = deployWorkflow.match(
			/^\s+NEXT_PUBLIC_API_URL:\s*(\S+)$/m,
		)?.[1];

		expect(buildTimeUrl).toBeDefined();
		expect(readWebWranglerVars().NEXT_PUBLIC_API_URL).toBe(buildTimeUrl);
	});

	it("web が使う NEXT_PUBLIC_* がすべて vars に揃っている", () => {
		// サンプルに載っているキーは web が使うキー。新しい NEXT_PUBLIC_* を
		// 足したとき、実行時への渡し忘れをここで捕まえる。
		//
		// Clerk の publishable key は Server Component から読まれないため
		// 除外する（秘密ではないが、使われない値を置いても意味が無い）。
		const runtimeVars = readWebWranglerVars();
		const publicKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		).filter(
			(key) =>
				key.startsWith("NEXT_PUBLIC_") && !key.startsWith("NEXT_PUBLIC_CLERK_"),
		);

		expect(publicKeys.length).toBeGreaterThan(0);
		for (const key of publicKeys) {
			expect(
				runtimeVars,
				`${key} が apps/web/wrangler.jsonc の vars に無い`,
			).toHaveProperty(key);
		}
	});

	it("vars に秘密情報を置いていない", () => {
		// vars は wrangler.jsonc に平文で入り、リポジトリにコミットされる。
		// シークレットは `wrangler secret put` で渡す（apps/api/wrangler.jsonc 参照）
		for (const [key, value] of Object.entries(readWebWranglerVars())) {
			expect(key, `${key} は vars ではなく secret で渡すこと`).not.toMatch(
				/SECRET|TOKEN|PASSWORD|PRIVATE/i,
			);
			expect(
				typeof value === "string" ? value : "",
				`${key} の値が秘密鍵らしい`,
			).not.toMatch(/^sk_/);
		}
	});
});
