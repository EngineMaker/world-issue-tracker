import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_LOCALE,
	getIssueScopeLabel,
	getIssueStatusLabel,
	ISSUE_SCOPE_LABELS,
	ISSUE_STATUS_LABELS,
	IssueScope,
	IssueStatus,
	Locale,
} from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

const homePage = readRepoFile("apps/web/src/app/page.tsx");

/**
 * page.tsx から JSX のコメントと行コメントを落とした本文。
 * コメントに文字列を書いただけで通ってしまうのを防ぐ
 */
const homePageBody = homePage
	.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "");

describe("トップページの導線", () => {
	it("Issue 一覧と起票への Link を持つ", () => {
		expect(homePageBody).toMatch(/<Link\s+href="\/issues"/);
		expect(homePageBody).toMatch(/<Link\s+href="\/issues\/new"/);
	});

	it("リンク先のページが実在し、404 にならない", () => {
		// 導線を置く以上その先が存在しないと、Issue #32 の
		// 「行き止まり」を別の行き止まりに置き換えただけになる
		for (const route of ["issues", "issues/new"]) {
			expect(
				existsSync(join(repoRoot, `apps/web/src/app/${route}/page.tsx`)),
				`/${route} のページが存在しない`,
			).toBe(true);
		}
	});

	it("遷移先からトップへ戻れる", () => {
		for (const route of ["issues", "issues/new"]) {
			const page = readRepoFile(`apps/web/src/app/${route}/page.tsx`);
			expect(page, `/${route} からトップへの導線が無い`).toMatch(
				/<Link\s+href="\/"/,
			);
		}
	});

	it("何をするサービスなのかを具体例つきで説明している", () => {
		// キャッチコピー「地球のバグ」だけでは何を投稿する場所か伝わらない
		expect(homePageBody).toContain("街灯");
		expect(homePageBody).toMatch(/投稿/);
	});

	it("閲覧にログインが不要であることを明示している", () => {
		// 「何があるか分からないサービスに人はログインしない」への対応
		expect(homePageBody).toMatch(/ログインは不要/);
	});

	it("説明も導線も main の中にあり、コメントアウトされていない", () => {
		const main = homePageBody.match(/<main>([\s\S]*)<\/main>/)?.[1];
		expect(main, "<main> が無い").toBeTruthy();
		expect(main).toContain("街灯");
		expect(main).toMatch(/<Link\s+href="\/issues"/);
		expect(main).toMatch(/<Link\s+href="\/issues\/new"/);
	});
});

describe("トップページの表示ラベル", () => {
	it("スコープ・ステータスをラベル経由で描画している", () => {
		// 修正前は `<li key={scope}>{scope}</li>` と enum 値を直接出していた
		expect(homePageBody).not.toMatch(/\{scope\}<\/li>/);
		expect(homePageBody).not.toMatch(/\{status\}<\/li>/);
		// ラベル辞書を参照していること（変数名は問わない）
		expect(homePageBody).toMatch(/ISSUE_SCOPE_LABELS|getIssueScopeLabel/);
		expect(homePageBody).toMatch(/ISSUE_STATUS_LABELS|getIssueStatusLabel/);
	});

	it("ユーザー向けの語彙でない in_progress を直接書いていない", () => {
		expect(homePageBody).not.toContain("in_progress");
	});

	it("スコープを定数の羅列ではなく説明つきで見せている", () => {
		expect(homePageBody).toMatch(/\.description|description\]/);
	});
});

describe("shared の表示ラベル", () => {
	it("既定ロケールが日本語である", () => {
		expect(DEFAULT_LOCALE).toBe("ja");
	});

	it("全ロケールで全スコープのラベルと説明が揃っている", () => {
		for (const locale of Locale.options) {
			for (const scope of IssueScope.options) {
				const entry = ISSUE_SCOPE_LABELS[locale][scope];
				expect(entry.label, `${locale}/${scope} のラベルが空`).not.toBe("");
				expect(entry.description, `${locale}/${scope} の説明が空`).not.toBe("");
			}
		}
	});

	it("全ロケールで全ステータスのラベルが揃っている", () => {
		for (const locale of Locale.options) {
			for (const status of IssueStatus.options) {
				expect(
					ISSUE_STATUS_LABELS[locale][status],
					`${locale}/${status} のラベルが空`,
				).not.toBe("");
			}
		}
	});

	it("ラベルが enum の生値をそのまま流用していない", () => {
		for (const scope of IssueScope.options) {
			expect(ISSUE_SCOPE_LABELS.ja[scope].label).not.toBe(scope);
		}
		for (const status of IssueStatus.options) {
			expect(ISSUE_STATUS_LABELS.ja[status]).not.toBe(status);
		}
	});

	it("同一ロケール内でラベルが重複しない", () => {
		// 「対応中」と「確認中」が同じ文字列だと状態を見分けられない
		for (const locale of Locale.options) {
			const statusLabels = IssueStatus.options.map(
				(status) => ISSUE_STATUS_LABELS[locale][status],
			);
			expect(new Set(statusLabels).size).toBe(statusLabels.length);

			const scopeLabels = IssueScope.options.map(
				(scope) => ISSUE_SCOPE_LABELS[locale][scope].label,
			);
			expect(new Set(scopeLabels).size).toBe(scopeLabels.length);
		}
	});

	it("日本語ラベルが意味に沿っている", () => {
		// ラベルを別の値に差し替えたり、対応関係を入れ替えたりすると落ちる。
		// 文言そのものより「どの状態がどの語に対応するか」を固定する意図
		expect(getIssueStatusLabel("open")).toBe("受付");
		expect(getIssueStatusLabel("in_progress")).toBe("対応中");
		expect(getIssueStatusLabel("resolved")).toBe("解決");
		expect(getIssueStatusLabel("closed")).toBe("クローズ");

		expect(getIssueScopeLabel("personal").label).toBe("個人");
		expect(getIssueScopeLabel("municipality").label).toBe("自治体");
		expect(getIssueScopeLabel("global").label).toBe("世界");
	});

	it("スコープの説明が階層の違いを説明している", () => {
		// 「概念の説明として見せる」ための説明文が、
		// ラベルの言い換えで終わっていないこと
		for (const scope of IssueScope.options) {
			const { label, description } = getIssueScopeLabel(scope);
			expect(description.length, `${scope} の説明が短すぎる`).toBeGreaterThan(
				label.length,
			);
		}
	});

	it("ロケールを指定すると英語ラベルを返す", () => {
		expect(getIssueStatusLabel("in_progress", "en")).toBe("In Progress");
		expect(getIssueScopeLabel("municipality", "en").label).toBe("Municipality");
	});
});

describe("トップページのスタイル", () => {
	const globalCss = readRepoFile("apps/web/src/app/globals.css");

	it("page.tsx が使うクラスが globals.css に定義されている", () => {
		// 既存の li は値をタグ状に見せる灰色背景のスタイル。
		// 説明文つきのリストに当たると潰れるため、打ち消すクラスが要る
		const used = [...homePage.matchAll(/className="([^"]+)"/g)].flatMap(
			(m) => m[1]?.split(/\s+/) ?? [],
		);
		expect(used.length).toBeGreaterThan(0);
		for (const className of used) {
			expect(globalCss, `.${className} が globals.css に無い`).toContain(
				`.${className}`,
			);
		}
	});

	it("説明文を伴うリストがタグ状の背景を打ち消している", () => {
		expect(globalCss).toMatch(/\.actions li[\s\S]*?background:\s*none/);
	});
});
