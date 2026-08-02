import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** git 管理下のファイル一覧。クローン直後に存在するファイルと一致する。 */
const trackedFiles = new Set(
	execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
		.split("\n")
		.filter(Boolean),
);

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/** `KEY=value` 形式の行からキー名を取り出す。コメント行と空行は無視する。 */
const parseEnvKeys = (content: string) =>
	content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split("=")[0] ?? "");

describe("README のセットアップ手順", () => {
	it("cp でコピーする元ファイルがすべて git 管理下にある", () => {
		const readme = readRepoFile("README.md");
		const sources = [...readme.matchAll(/^cp\s+(\S+)\s+\S+$/gm)].map(
			(match) => match[1],
		);

		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) {
			expect(
				trackedFiles,
				`README が参照する ${source} が存在しない`,
			).toContain(source);
		}
	});
});

describe("環境変数のサンプルファイル", () => {
	it("apps/api/.dev.vars.example が Bindings の CLERK_* キーを網羅している", () => {
		// Bindings 型のうち DB は wrangler.jsonc のバインディングなので
		// .dev.vars で渡すのは CLERK_* のみ
		const bindings = readRepoFile("apps/api/src/index.ts");
		const secretKeys = [
			...bindings.matchAll(/^\t(CLERK_\w+):\s*string;$/gm),
		].map((match) => match[1]);
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/api/.dev.vars.example"),
		);

		expect(secretKeys.length).toBeGreaterThan(0);
		for (const key of secretKeys) {
			expect(exampleKeys, `${key} が .dev.vars.example にない`).toContain(key);
		}
	});

	it("apps/web/.env.local.example が Clerk のキーを含む", () => {
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		);

		expect(exampleKeys).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
		expect(exampleKeys).toContain("CLERK_SECRET_KEY");
	});

	it("サンプルファイルが実際の値を含まない", () => {
		const examples = [
			"apps/api/.dev.vars.example",
			"apps/web/.env.local.example",
		];

		for (const path of examples) {
			for (const line of readRepoFile(path).split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const separator = trimmed.indexOf("=");
				const key = trimmed.slice(0, separator);
				const value = trimmed.slice(separator + 1);

				// URL のような公開してよい設定値は実値のままサンプルに書く。
				// 秘匿すべきなのは資格情報なので、検査対象をそちらに限定する。
				// ここを緩めすぎると実キーの混入を見逃すため、
				// 「除外してよいキー」を列挙する側（許可リスト）にしている。
				if (key === "NEXT_PUBLIC_API_URL") {
					expect(value, `${path} の ${key} が URL でない`).toMatch(
						/^https?:\/\//,
					);
					continue;
				}

				// Clerk の実キーはランダム文字列が続く。
				// プレースホルダは `xxxx` で終わることを必須とする
				expect(value, `${path} に実値らしき文字列がある: ${line}`).toMatch(
					/x{4,}$/,
				);
			}
		}
	});

	it("apps/web/.env.local.example が API のベース URL を含む", () => {
		const exampleKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		);

		expect(exampleKeys).toContain("NEXT_PUBLIC_API_URL");
	});

	it("サンプルは git 管理下にあり、実体は .gitignore で無視されている", () => {
		expect(trackedFiles).toContain("apps/api/.dev.vars.example");
		expect(trackedFiles).toContain("apps/web/.env.local.example");
		expect(trackedFiles).not.toContain("apps/api/.dev.vars");
		expect(trackedFiles).not.toContain("apps/web/.env.local");
	});
});

/**
 * `NEXT_PUBLIC_*` は Next.js のビルド時に値が埋め込まれる。デプロイの
 * ワークフローで渡し忘れると、本番の Web がローカルの API を見に行き、
 * 一覧が空のまま何のエラーも出ない。ユニットテストでは検出できない種類の
 * 事故なので、ワークフローの記述そのものを検査する。
 */
describe("デプロイワークフローの環境変数", () => {
	const deployWorkflow = readRepoFile(".github/workflows/deploy.yml");

	it("web のビルドに NEXT_PUBLIC_API_URL を渡している", () => {
		expect(deployWorkflow).toMatch(/^\s+NEXT_PUBLIC_API_URL:\s*\S+$/m);
	});

	it("渡している API URL が本番の API を指している", () => {
		const match = deployWorkflow.match(/^\s+NEXT_PUBLIC_API_URL:\s*(\S+)$/m);
		expect(match?.[1]).toBe(
			"https://world-issue-tracker-api.mktoho.workers.dev",
		);
	});

	it("web が使う NEXT_PUBLIC_* がすべてワークフローで渡されている", () => {
		// サンプルに載っているキーは web が使うキー。
		// 新しい NEXT_PUBLIC_* を足したときの渡し忘れをここで捕まえる
		const publicKeys = parseEnvKeys(
			readRepoFile("apps/web/.env.local.example"),
		).filter((key) => key.startsWith("NEXT_PUBLIC_"));

		expect(publicKeys.length).toBeGreaterThan(0);
		for (const key of publicKeys) {
			expect(deployWorkflow, `${key} が deploy.yml で渡されていない`).toContain(
				`${key}:`,
			);
		}
	});
});
