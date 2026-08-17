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
	UI_MESSAGES,
} from "@world-issue-tracker/shared";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const readRepoFile = (relativePath: string) =>
	readFileSync(join(repoRoot, relativePath), "utf8");

const homePage = readRepoFile("apps/web/src/app/page.tsx");

/**
 * ステータスのピル（#95）。トップ・一覧・詳細が共通で使う。
 * ラベルを辞書から引く責任がここへ移ったので、照合先として読む
 */
const statusPill = readRepoFile("apps/web/src/app/components/StatusPill.tsx");

/**
 * page.tsx から JSX のコメントと行コメントを落とした本文。
 * コメントに文字列を書いただけで通ってしまうのを防ぐ
 */
const homePageBody = homePage
	.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/^\s*\/\/.*$/gm, "");

/**
 * `<Link ... href="<パス>">` があるかを見る。
 *
 * 以前は `/<Link\s+href="..."/ ` と、`href` が最初の属性であることを
 * 前提にしていた。#95 で `<Link className="button-link" href="/issues/new">`
 * のように属性を足したところ、導線は存在するのにテストだけが落ちた。
 * 見たいのは「その遷移先への Link があるか」であって属性の順序ではないので、
 * `<Link` から `>` までの間に該当の `href` があるかで照合する。
 */
const hasLinkTo = (source: string, path: string): boolean =>
	[...source.matchAll(/<Link\s[^>]*>/g)].some((m) =>
		m[0].includes(`href="${path}"`),
	);

describe("トップページの導線", () => {
	it("Issue 一覧と起票への Link を持つ", () => {
		expect(hasLinkTo(homePageBody, "/issues")).toBe(true);
		expect(hasLinkTo(homePageBody, "/issues/new")).toBe(true);
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
		// `/issues/new` はフォーム本体を `NewIssueForm` に切り出している
		// （Issue #82。Client Component へロケールを props で渡すため）。
		// 導線はそちらにあるので、ページと実体の両方を見る
		const pagesByRoute: Record<string, string[]> = {
			issues: ["apps/web/src/app/issues/page.tsx"],
			"issues/new": [
				"apps/web/src/app/issues/new/page.tsx",
				"apps/web/src/app/components/NewIssueForm.tsx",
			],
		};

		for (const [route, paths] of Object.entries(pagesByRoute)) {
			const sources = paths.map(readRepoFile).join("\n");
			expect(sources, `/${route} からトップへの導線が無い`).toMatch(
				/<Link\s+href="\/"/,
			);
		}
	});

	// 文言は `packages/shared` の `UI_MESSAGES` に外部化した（Issue #82）ので、
	// 「何を伝えているか」は page.tsx のソースではなく辞書を見る。
	// ページ側は「その文言を実際に描画しているか」だけを見る（下の it）。
	//
	// 全ロケールを回しているのは、翻訳したときに具体例や案内が抜け落ちるのを
	// 防ぐため。日本語だけ通せばよいことにすると、英語版が中身の薄い直訳でも
	// 気付けない
	it("何をするサービスなのかを具体例つきで説明している", () => {
		// キャッチコピー「地球のバグ」だけでは何を投稿する場所か伝わらない
		for (const locale of Locale.options) {
			const home = UI_MESSAGES[locale].home;
			const about = `${home.aboutBody1}${home.aboutBody2}`;

			expect(about, `${locale} に身近な具体例が無い`).toMatch(
				/街灯|streetlight/i,
			);
			expect(about, `${locale} に投稿するという説明が無い`).toMatch(
				/投稿|post/i,
			);
		}
	});

	it("閲覧にログインが不要であることを明示している", () => {
		// 「何があるか分からないサービスに人はログインしない」への対応
		for (const locale of Locale.options) {
			expect(
				UI_MESSAGES[locale].home.viewIssuesHint,
				`${locale} に閲覧がログイン不要である案内が無い`,
			).toMatch(/ログインは不要|No sign-in required/i);
		}
	});

	it("説明も導線も main の中にあり、コメントアウトされていない", () => {
		const main = homePageBody.match(/<main>([\s\S]*)<\/main>/)?.[1];
		expect(main, "<main> が無い").toBeTruthy();
		// 説明の本文そのものは辞書にあるので、辞書のどのキーを描いているかで見る。
		// キーごと消せばここが落ちる
		expect(main).toContain("messages.home.aboutBody1");
		expect(main).toContain("messages.home.aboutBody2");
		expect(hasLinkTo(main ?? "", "/issues")).toBe(true);
		expect(hasLinkTo(main ?? "", "/issues/new")).toBe(true);
	});
});

describe("トップページの表示ラベル", () => {
	it("スコープ・ステータスをラベル経由で描画している", () => {
		// 修正前は `<li key={scope}>{scope}</li>` と enum 値を直接出していた
		expect(homePageBody).not.toMatch(/\{scope\}<\/li>/);
		expect(homePageBody).not.toMatch(/\{status\}<\/li>/);
		// ラベル辞書を参照していること（変数名は問わない）
		expect(homePageBody).toMatch(/ISSUE_SCOPE_LABELS|getIssueScopeLabel/);
		/*
		 * ステータスは #95 で `StatusPill` に切り出した（一覧・詳細と同じ
		 * ピルを使うため）。page.tsx から辞書の参照は消えたが、ラベル経由で
		 * 描いていることは変わらないので、描画を担う側を見る。
		 * ここを page.tsx だけに限ると、切り出しただけで落ちるテストになる
		 */
		expect(statusPill).toMatch(/ISSUE_STATUS_LABELS|getIssueStatusLabel/);
		/*
		 * 切り出し先を見るだけだと、page.tsx がそれを使っていなくても通る。
		 * 実際に描画に使っていることまで見る
		 */
		expect(homePageBody).toMatch(/<StatusPill\b/);
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
