/**
 * 本番デプロイ前の Clerk キー検査（Issue #98）のテスト。
 *
 * #98 の本体は「Clerk に本番インスタンスを作ってキーを差し替える」という
 * 運用作業で、コードでは表現できない。ここで固定したいのは
 * **同じ取り違えが二度と黙って本番へ出ないこと**の方。
 *
 * 開発用キーは、ローカルでも CI でも本番でも同じように動いてしまう。
 * ビルドも型検査もテストも全部通る。だから #98 は本番を人が操作するまで
 * 見つからなかった。この検査はその一点だけを担当する。
 *
 * 検証の主題は「開発用キーで本番デプロイが止まるか」に置く。
 * 判定関数が正しい値を返すだけでは足りず、`deploy` の経路に
 * 実際に繋がっていること（package.json）まで見る。関数があっても
 * 呼ばれていなければ #98 は再発する。
 */

import { describe, expect, it } from "bun:test";
import {
	clerkKeyKind,
	isUnsafeForProduction,
} from "@world-issue-tracker/shared";
import packageJson from "../package.json";
import { findUnsafeClerkKeys } from "../scripts/check-clerk-keys";

/** #98 の時点で本番に出ていた実物の publishable key（デコードすると composed-jaguar-94.clerk.accounts.dev）。 */
const PRODUCTION_KEY_AT_ISSUE_98 =
	"pk_test_Y29tcG9zZWQtamFndWFyLTk0LmNsZXJrLmFjY291bnRzLmRldiQ";

describe("clerkKeyKind", () => {
	it("識別する: pk_live_ / sk_live_ は本番用", () => {
		expect(clerkKeyKind("pk_live_abcdef")).toBe("production");
		expect(clerkKeyKind("sk_live_abcdef")).toBe("production");
	});

	it("識別する: pk_test_ / sk_test_ は開発用", () => {
		expect(clerkKeyKind("pk_test_abcdef")).toBe("development");
		expect(clerkKeyKind("sk_test_abcdef")).toBe("development");
	});

	it("#98 で実際に本番へ出ていたキーを開発用と判定する", () => {
		// 回帰の起点。このキーが production 扱いになったら判定が壊れている。
		expect(clerkKeyKind(PRODUCTION_KEY_AT_ISSUE_98)).toBe("development");
	});

	it("判定できないものは null を返す（本番用と断定しない）", () => {
		expect(clerkKeyKind(undefined)).toBeNull();
		expect(clerkKeyKind("")).toBeNull();
		expect(clerkKeyKind("pk_prod_abcdef")).toBeNull();
		expect(clerkKeyKind("live_abcdef")).toBeNull();
		// 接頭辞は先頭に無ければならない。埋め込まれていても本番用にしない。
		expect(clerkKeyKind("xpk_live_abcdef")).toBeNull();
	});
});

describe("isUnsafeForProduction", () => {
	it("本番用キーだけを安全と見なす", () => {
		expect(isUnsafeForProduction("pk_live_abcdef")).toBe(false);
		expect(isUnsafeForProduction("sk_live_abcdef")).toBe(false);
	});

	it("判定不能・未設定は安全側に倒さない", () => {
		// 「分からないから通す」にすると、Clerk が接頭辞を変えた日に
		// 検査が黙って無効化される。
		expect(isUnsafeForProduction(undefined)).toBe(true);
		expect(isUnsafeForProduction("")).toBe(true);
		expect(isUnsafeForProduction("pk_prod_abcdef")).toBe(true);
	});
});

describe("findUnsafeClerkKeys", () => {
	const validEnv = {
		NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_abcdef",
		CLERK_SECRET_KEY: "sk_live_abcdef",
	};

	it("両方が本番用なら問題を報告しない", () => {
		expect(findUnsafeClerkKeys(validEnv)).toEqual([]);
	});

	it("#98 の状態（publishable key が開発用）を検出する", () => {
		const problems = findUnsafeClerkKeys({
			...validEnv,
			NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PRODUCTION_KEY_AT_ISSUE_98,
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
		expect(problems[0]).toContain("開発用インスタンス");
	});

	it("secret key だけが開発用でも検出する", () => {
		// 片方だけ切り替える事故（#98 の補足）を通さないこと。
		const problems = findUnsafeClerkKeys({
			...validEnv,
			CLERK_SECRET_KEY: "sk_test_abcdef",
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("CLERK_SECRET_KEY");
	});

	it("両方が開発用なら 2 件まとめて報告する", () => {
		// 片方直して再実行、をもう片方で繰り返させない。
		const problems = findUnsafeClerkKeys({
			NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abcdef",
			CLERK_SECRET_KEY: "sk_test_abcdef",
		});
		expect(problems).toHaveLength(2);
	});

	it("未設定を「問題なし」と扱わない", () => {
		// 取得に失敗した／空だったを「安全」に倒すと、認証が丸ごと
		// 動かないビルドが本番へ出る。
		const problems = findUnsafeClerkKeys({});
		expect(problems).toHaveLength(2);
		for (const problem of problems) {
			expect(problem).toContain("設定されていません");
		}
	});

	it("Clerk のキーの形式でない値を通さない", () => {
		const problems = findUnsafeClerkKeys({
			...validEnv,
			CLERK_SECRET_KEY: "some-other-value",
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("形式");
	});
});

describe("deploy スクリプトへの接続", () => {
	/**
	 * 判定関数が正しくても、`deploy` から呼ばれていなければ #98 は再発する。
	 * ここが「テストは通るのに本番は守られていない」を防ぐ唯一の砦なので、
	 * package.json の実際の文字列を見る。
	 */
	it("deploy がビルドの前に検査を走らせる", () => {
		const deploy = packageJson.scripts.deploy;
		expect(deploy).toContain("scripts/check-clerk-keys.ts");

		// 「前に」であることまで見る。ビルドの後に置くと、
		// 開発用キーで作った成果物が出来上がってから止まることになり、
		// うっかり `opennextjs-cloudflare deploy` だけ手で叩くと素通りする。
		const checkAt = deploy.indexOf("scripts/check-clerk-keys.ts");
		const buildAt = deploy.indexOf("opennextjs-cloudflare build");
		expect(checkAt).toBeGreaterThanOrEqual(0);
		expect(buildAt).toBeGreaterThanOrEqual(0);
		expect(checkAt).toBeLessThan(buildAt);
	});
});
