import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import DesignDirectionPage from "../src/app/design-direction/page";

const SPEC_PATH = join(import.meta.dir, "../../../docs/design-direction.md");

describe("design direction page", () => {
	it("承認済みの 4 つの見本をリポジトリ内で見られる", () => {
		const html = renderToStaticMarkup(<DesignDirectionPage />);
		for (const text of [
			"トップページ",
			"Issue 一覧",
			"Issue 詳細（写真あり）",
			"Issue 詳細（写真なし）",
			"空の状態と待ち時間",
			"追加トークンと根拠",
			"素材の一覧とライセンス",
		]) {
			expect(html).toContain(text);
		}
	});

	it("見出しの結論と唯一の既存値変更を明記する", () => {
		const html = renderToStaticMarkup(<DesignDirectionPage />);
		expect(html).toContain("見出しの段階");
		expect(html).toContain("見出し専用に 3 段階を残す");
		expect(html).toContain("1.0625rem");
	});
});

describe("design direction spec doc", () => {
	const spec = readFileSync(SPEC_PATH, "utf8");

	it("ブラウザで開く場所と実装への引き継ぎ先を書く", () => {
		expect(spec).toContain("/design-direction");
		expect(spec).toContain("#95");
	});

	it("トークンの値と素材ライセンス一覧を残す", () => {
		for (const text of [
			"--shadow-card",
			"--radius-md",
			"--text-heading-site",
			"外部素材なし",
			"MIT License",
		]) {
			expect(spec).toContain(text);
		}
	});
});
