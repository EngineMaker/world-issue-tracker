import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

/**
 * デプロイ経路に Clerk キーの関門があること（#98 の積み残し）。
 *
 * #98 の一次対応（PR #100）は web にだけ関門を置いた。`bun run deploy` が
 * ビルドの手前で `pk_live_`/`sk_live_` を確かめ、開発用キーなら止まる。
 * だが本番へ出る経路は web だけではない。
 *
 * `deploy.yml` の `deploy-api` は `bun wrangler deploy` を直接叩いており、
 * Clerk のキーに触れる箇所が一つも無い。つまり **API は開発用キーのまま
 * 何の抵抗もなく本番へ出る**。しかも `deploy-api` と `deploy-web` は
 * 独立したジョブなので同時に走る。web が関門で落ちても API は出てしまい、
 * #98 の補足が名指しで警告している「トークンを発行した先と検証する先が
 * 食い違って認証が通らなくなる」状態を、CI 自身が作れる。
 *
 * API のキーは Workers Secrets にあり、値は書き込み専用で読み出せない
 * （`wrangler secret list` が返すのは名前と型だけ）。よってビルド前の
 * 静的な検査はできない。代わりに**デプロイ後の本番 API 自身に種別を
 * 答えさせて**確かめる。実際に本番で動いている値を見るので、
 * ビルド時の環境変数を見るより確実でもある。
 *
 * ここで検査するのはワークフローの記述そのもの。関門の中身が正しくても
 * ワークフローから呼ばれていなければ #98 は再発するし、それは
 * ユニットテストでは決して検出できない。
 */
describe("デプロイワークフローの Clerk キー関門", () => {
	const deployWorkflow = readRepoFile(".github/workflows/deploy.yml");

	it("API のデプロイ後に Clerk のキー種別を検証する手順がある", () => {
		expect(deployWorkflow).toContain("scripts/verify-clerk-instance.ts");
	});

	it("検証は API のデプロイより後に置かれている", () => {
		// 前に置くと、まだ古いコードが動いている本番を検査することになり、
		// 今まさに出そうとしているキーの種別を確かめたことにならない。
		const deployAt = deployWorkflow.indexOf("bun wrangler deploy");
		const verifyAt = deployWorkflow.indexOf("scripts/verify-clerk-instance.ts");

		expect(deployAt).toBeGreaterThanOrEqual(0);
		expect(verifyAt).toBeGreaterThanOrEqual(0);
		expect(verifyAt).toBeGreaterThan(deployAt);
	});

	it("web のデプロイは API のデプロイ完了を待つ", () => {
		// #98 の補足にある「両方を同時に切り替えること」を、CI の側でも守る。
		// 並走させると、API だけ本番用・web だけ開発用（またはその逆）で
		// 本番が動く時間帯ができる。その間サインインは通らない。
		expect(deployWorkflow).toMatch(/deploy-web:[\s\S]*?needs:\s*deploy-api/);
	});
});
