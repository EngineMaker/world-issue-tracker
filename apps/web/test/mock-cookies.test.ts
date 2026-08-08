import { describe, expect, it } from "bun:test";
import "./helpers/mock-cookies";

/**
 * `next/headers` のモックが、実物と同じ export を揃えていることを見る。
 *
 * `mock.module` はモジュール全体を差し替えるため、モックに書き忘れた export は
 * 「存在しない」ことになる。このリポジトリが直接使うのは `cookies` だけだが、
 * `@clerk/nextjs` が `import { headers } from "next/headers"` をしているので、
 * `headers` を出さないと Clerk を読み込むテストが
 * `Export named 'headers' not found in module` で落ちる。
 *
 * 実際に CI がこれで失敗した。手元では Clerk を読むテストがたまたま
 * 後に走っていたため再現せず、原因の特定に CI を2周使った。
 * 実行順に関係なく落ちるこのテストを置いて、次は手元で気付けるようにする。
 */
describe("next/headers のモック", () => {
	it("実物と同じ export を揃えている", async () => {
		const mocked = await import("next/headers");

		// 直接使うもの
		expect(typeof mocked.cookies).toBe("function");
		// 使わないが、依存パッケージが import するもの
		expect(typeof mocked.headers).toBe("function");
		expect(typeof mocked.draftMode).toBe("function");
	});

	it("cookies() は get() を持つオブジェクトを返す", async () => {
		const { cookies } = await import("next/headers");
		const store = await cookies();

		expect(typeof store.get).toBe("function");
	});
});
