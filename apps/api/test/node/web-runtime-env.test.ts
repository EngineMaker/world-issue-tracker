/**
 * Web の Worker のデプロイ設定（`apps/web/wrangler.jsonc`）の検査。
 *
 * ユニットテストでも型チェックでもビルドでも素通りし、デプロイして初めて
 * 壊れる種類の設定を、記述そのものを読んで固定する。
 *
 * ここで検査できるのは「設定がそう書かれているか」までで、
 * 「実行時に本当に繋がるか」は担保しない。#55 でその限界が実際に出た
 * （`vars` は正しく書かれていたが、Server Component へは届かない経路だった）。
 * 経路が繋がっていることの確認は、デプロイ後に本番 URL を叩くしかない。
 *
 * `NEXT_PUBLIC_*` の値については、Next.js が **ビルド時に静的置換する**ため
 * Server Component にも `vars` は届かない。値を届ける経路はビルド時の
 * `.github/workflows/deploy.yml` 一本（詳細は wrangler.jsonc のコメント）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../helpers/jsonc";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/** `KEY=value` 形式の行からキー名を取り出す。コメント行と空行は無視する。 */
const parseEnvKeys = (content: string) =>
	content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split("=")[0] ?? "");

function readWebWranglerConfig(): Record<string, unknown> {
	const config = parseJsonc(readRepoFile("apps/web/wrangler.jsonc"));
	if (typeof config !== "object" || config === null) {
		throw new Error("apps/web/wrangler.jsonc がオブジェクトではない");
	}
	return config as Record<string, unknown>;
}

function readWebWranglerVars(): Record<string, unknown> {
	const vars = readWebWranglerConfig().vars;
	if (typeof vars !== "object" || vars === null) return {};
	return vars as Record<string, unknown>;
}

function readWebCompatibilityFlags(): string[] {
	const flags = readWebWranglerConfig().compatibility_flags;
	if (!Array.isArray(flags)) return [];
	return flags.filter((flag): flag is string => typeof flag === "string");
}

/**
 * deploy.yml がビルド時に渡す API の URL。
 *
 * Server Component にも Client Component にも、実際に焼き込まれるのはこちらの値
 * （`vars` は届かない）。URL そのものを検査するときはこちらを見る。
 */
function readBuildTimeApiUrl(): string | undefined {
	return readRepoFile(".github/workflows/deploy.yml").match(
		/^\s+NEXT_PUBLIC_API_URL:\s*(\S+)$/m,
	)?.[1];
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

/**
 * Web の Worker から API の Worker へ `fetch` が届くための設定。
 *
 * 既定の Workers ランタイムは、同一アカウント内の `*.workers.dev` 宛て
 * subrequest を相手の Worker を起動する前に 404 で返す。Server Component は
 * `fetch` で API を呼ぶため、この状態だと外部からの curl は 200 なのに
 * 本番の一覧だけ「API が 404 を返しました」になる（#55）。
 *
 * 設定ファイルの検査なので「実際に繋がること」は担保できない。ここで守るのは
 * 「一度直した設定が黙って外れないこと」だけ。実際に繋がるかはデプロイ後に
 * 本番 URL を叩いて確認する。
 */
describe("web の Worker から API の Worker への fetch", () => {
	it("compatibility_flags に global_fetch_strictly_public がある", () => {
		expect(
			readWebCompatibilityFlags(),
			"これが無いと Worker 間の fetch が相手を起動せず 404 になる（#55）",
		).toContain("global_fetch_strictly_public");
	});

	it("既存の nodejs_compat を落としていない", () => {
		// フラグは配列ごと差し替える形なので、追記のつもりで上書きすると
		// OpenNext が要求する nodejs_compat が消える。消えるとデプロイは
		// 通るのにワーカーが起動時に落ちる
		expect(readWebCompatibilityFlags()).toContain("nodejs_compat");
	});

	it("Server Component が呼ぶ API がフラグの対象になる別 Worker である", () => {
		// 同一アカウントの workers.dev 宛てだからこの制約を受ける。
		// 将来カスタムドメインへ移すなど前提が変わったら、このテストが落ちて
		// フラグの要否を見直す機会になる。
		//
		// 実際に焼き込まれるのは deploy.yml の値なので、`vars` ではなく
		// そちらを見る
		expect(readBuildTimeApiUrl()).toMatch(
			/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/,
		);
	});
});

describe("web の Worker に vars として渡す環境変数", () => {
	it("wrangler.jsonc の vars に NEXT_PUBLIC_API_URL がある", () => {
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

	it("deploy.yml と同じ URL を渡している", () => {
		// 実際に使われるのは deploy.yml 側（ビルド時の埋め込み）だが、
		// 二つの値がズレていると設定を読んだ人が実態を取り違える。
		// 片方だけ書き換えられないよう一致を固定しておく
		const buildTimeUrl = readBuildTimeApiUrl();

		expect(buildTimeUrl).toBeDefined();
		expect(readWebWranglerVars().NEXT_PUBLIC_API_URL).toBe(buildTimeUrl);
	});

	it("web が使う NEXT_PUBLIC_* がすべて vars に揃っている", () => {
		// サンプルに載っているキーは web が使うキー。新しい NEXT_PUBLIC_* を
		// 足したとき、こちらへの書き忘れをここで捕まえる。
		//
		// Clerk の publishable key は除外する。`@clerk/nextjs` がビルド時の
		// 埋め込みで受け取るため、ここに置いても使われない。
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
